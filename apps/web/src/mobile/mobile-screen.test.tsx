import type { RenderResult } from 'vitest-browser-react'
import { cdp, page, server, userEvent } from 'vitest/browser'
import { mouse } from 'vitest-browser-commands/playwright'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { StrictMode, type ReactElement } from 'react'
import { act } from '@/test-utils/act.ts'
import { createTestAppServices, type TestAppServices } from '@reflect/app/testing'
import {
  createTestChatEngineService,
  createTestCoreServices,
  createTestSecretStoreService,
  type TestCoreServices,
} from '@reflect/core/testing'
import {
  clearFormattingToolbar,
  publishFormattingToolbar,
} from '@/editor/formatting-toolbar-store.ts'
import { useRouterActions } from '@/routing/router.tsx'
import { addDaysToIsoDate, getYearMonth, getIsoToday } from '@reflect/utils'
import {
  type AiProviderConfig,
  type DailyNoteService,
  type GraphInfo,
  aiKeySecretName,
  formatDayLabel,
} from '@reflect/core'
import { type Route, createWeekWindow, weekOf, formatMonthLabel } from '@reflect/app'
import { fireEvent } from '@/test-utils/fire-event.ts'
import { dispatchTouch, scrollElement, touch } from '@/test-utils/scroll.ts'
import { emulateReducedMotion } from '@/test-utils/reduced-motion.ts'
import '@/test-utils/locator.ts'
import { renderInApp, type RenderInAppOptions } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { MobileAudioMemoProvider } from './audio-memo-provider.tsx'
import { AllSearchProvider } from '@/mobile/all-search.tsx'
import { quickOpenVisible } from '@/mobile/quick-open.tsx'
import { MobileShell } from './mobile-shell.tsx'
import { BACK_PAGER_OVERSHOOT_PX } from './use-back-pager.ts'
import { noop, returnFalse, sleep } from '@ocavue/utils'

const waitFor = vi.waitFor

/**
 * The tabbed mobile shell (Plan 19, V1 parity): the daily spine pages
 * between days, the All tab lists and searches, a note screen pops back to
 * where it came from, and a cold note entry lands on today. Drives the real
 * router → MobileShell → screens → NotePane stack over the test app services;
 * only the ProseMirror view is stubbed, mirroring `route-content.test.tsx`.
 */

const editorProbe = vi.hoisted(() => ({
  focusCalls: 0,
  selectionCalls: [] as Array<'start' | 'end'>,
}))
vi.mock('@/editor/note-editor.tsx', async () => {
  const { useEffect, useRef } = await import('react')
  return {
    NoteEditor: ({
      initialContent,
      onWikiLinkClick,
      handleRef,
    }: {
      initialContent: string
      onWikiLinkClick?: (options: { target: string; openInNewWindow: boolean }) => void
      handleRef?: (
        handle: import('@/editor/note-editor.tsx').NoteEditorHandle | null,
      ) => void | (() => void)
    }) => {
      const markdownRef = useRef(initialContent)
      useEffect(() => {
        const cleanup = handleRef?.({
          setMarkdown: (markdown) => {
            markdownRef.current = markdown
          },
          getMarkdown: () => markdownRef.current,
          insertMarkdown: noop,
          focus: () => {
            editorProbe.focusCalls += 1
          },
          setSelection: (position: 'start' | 'end') => {
            editorProbe.selectionCalls.push(position)
          },
          getSelectedText: () => '',
          openSelectionMenu: noop,
          startPendingReplacement: returnFalse,
          appendPendingReplacementText: noop,
          acceptPendingReplacement: noop,
          discardPendingReplacement: noop,
          findNext: noop,
          findPrevious: noop,
        })
        return () => {
          if (typeof cleanup === 'function') {
            cleanup()
          } else {
            handleRef?.(null)
          }
        }
      }, [handleRef])
      return (
        <div data-testid="fake-editor">
          {initialContent}
          {onWikiLinkClick ? (
            <button
              type="button"
              onClick={() => onWikiLinkClick({ target: 'Target Note', openInNewWindow: false })}
            >
              fake-wikilink
            </button>
          ) : null}
        </div>
      )
    },
  }
})
const GRAPH: GraphInfo = { root: '/g', name: 'g', generation: 1 }

// The services of the running test: the graph's files live in `core.noteFile`.
let core: TestCoreServices
let appServices: TestAppServices
let dailyDatesInRange: MockInstance<DailyNoteService['dailyDatesInRange']>

beforeEach(async () => {
  await page.viewport(375, 700)
  core = createTestCoreServices({ database: createWasmTestDatabaseService() })
  appServices = createTestAppServices(core)
  // The tests compute dates from the real clock.
  core.clock.setNow(Date.now())
  // The browser and the test preferences both prefer reduced motion.
  await emulateReducedMotion(true)
  appServices.systemPreferences.reducedMotion.set(true)
  dailyDatesInRange = vi.spyOn(core.dailyNotes, 'dailyDatesInRange').mockResolvedValue([])
  editorProbe.focusCalls = 0
  editorProbe.selectionCalls = []
})

function mount(
  initialRoute: Route,
  probeRoute?: Route,
  options?: { strict?: boolean; settings?: RenderInAppOptions['settings'] },
) {
  const tree = (
    <AllSearchProvider>
      <MobileAudioMemoProvider graph={GRAPH}>
        <MobileShell />
        {probeRoute ? <NavProbe to={probeRoute} /> : null}
      </MobileAudioMemoProvider>
    </AllSearchProvider>
  )
  // The app runs under StrictMode (main.tsx); opt in where a test guards
  // against impure updaters (dev double-invocation caught a double-pop once).
  return renderInApp(options?.strict ? <StrictMode>{tree}</StrictMode> : tree, {
    core,
    appServices,
    graph: GRAPH,
    route: initialRoute,
    settings: {
      editorMarkdownSyntax: 'hide',
      dateFormat: 'mdy',
      weekStartDay: 'monday',
      ...options?.settings,
    },
  })
}

/** Stands in for a wiki-link tap: navigation arriving from inside a screen. */
function NavProbe({ to }: { to: Route }): ReactElement {
  const { navigate } = useRouterActions()
  return (
    <button type="button" onClick={() => navigate(to)}>
      probe-navigate
    </button>
  )
}

/** Every mounted stack layer, in DOM order (below → current → exiting). */
type BrowserView = RenderResult

function stackLayers(view: BrowserView): HTMLElement[] {
  return Array.from(view.container.querySelectorAll<HTMLElement>('.mobile-stack-layer'))
}

/** The screen the user sees — the one stack layer not hidden as a11y-inert. */
function visibleLayer(view: BrowserView): HTMLElement {
  const visible = stackLayers(view).find((layer) => layer.getAttribute('aria-hidden') !== 'true')
  if (!visible) {
    throw new Error('no visible mobile-stack layer')
  }
  return visible
}

/**
 * Finishes the animations of the stack layers and the scrim until no layer
 * slides.
 */
async function finishStackAnimations(view: BrowserView): Promise<void> {
  await waitFor(async () => {
    await act(async () => {
      const animations = Array.from(
        view.container.querySelectorAll('.mobile-stack-layer, .mobile-stack-scrim'),
      ).flatMap((element) => element.getAnimations())
      for (const animation of animations) {
        animation.finish()
      }
      await Promise.allSettled(animations.map((animation) => animation.finished))
    })
    expect(
      view.container.querySelector('.mobile-stack-slide-in, .mobile-stack-slide-out'),
    ).toBeNull()
  })
}

async function fireClick(element: Element): Promise<void> {
  await act(() => {
    fireEvent.click(element)
  })
}

/** The calendar strip's per-day aria-label (CalendarStrip uses this form). */
function dayCellLabel(date: string): string {
  return formatDayLabel(date, 'mdy')
}

/**
 * The strip header's settled month label — a month change rolls the old
 * label out, so the heading's whole textContent briefly holds both.
 */
function shownMonth(view: BrowserView): string | null {
  return (
    view.getByRole('heading', { level: 1 }).element().querySelector('[data-slot="month-title"]')
      ?.textContent ?? null
  )
}

/**
 * Picks the `YYYY-MM` `month` from the month title: through the native month
 * input where the browser has one, else through the picker sheet.
 */
async function pickMonthFromTitle(view: BrowserView, month: string): Promise<void> {
  const trigger = view.getByLabelText('Change month')
  if (trigger.element() instanceof HTMLInputElement) {
    await userEvent.fill(trigger, month)
    return
  }
  await userEvent.click(trigger)
  const monthButton = view.getByRole('button', { name: formatMonthLabel(month) })
  while (monthButton.query() === null) {
    await userEvent.click(view.getByRole('button', { name: 'Next year' }))
  }
  await userEvent.click(monthButton)
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
}

/** A day in `date`'s week that isn't `date` itself (always present). */
function otherDayInWeek(date: string): string {
  const week = weekOf(date, 'monday')
  return week.find((day) => day !== date) ?? week[0]!
}

describe('MobileShell', () => {
  it('renders today as the daily spine with its note content', async () => {
    const today = getIsoToday()
    core.noteFile.set(`daily/${today}.md`, 'captured on the go')
    const view = await mount({ kind: 'today' })

    // The header is the month; the carousel mounts today's slide (±1
    // neighbours), each carrying its formatted date as the note's subject.
    expect(shownMonth(view)).toBe(formatMonthLabel(getYearMonth(today)))
    await expect.element(view.getByText(formatDayLabel(today, 'mdy'))).toBeVisible()
    await waitFor(() => {
      const editors = view.getByTestId('fake-editor').elements()
      expect(editors.some((editor) => editor.textContent?.includes('captured on the go'))).toBe(
        true,
      )
    })
  })

  it('selects a day from the calendar strip and jumps back to today', async () => {
    const user = userEvent
    const today = getIsoToday()
    const other = otherDayInWeek(today)
    const view = await mount({ kind: 'today' })

    expect(view.getByRole('button', { name: 'Today' }).query()).toBeNull()
    const todayButton = view.getByText('Today')
    expect(todayButton.element().classList.contains('opacity-0')).toBe(true)
    expect(todayButton.element().hasAttribute('inert')).toBe(true)

    await user.click(view.getByRole('button', { name: dayCellLabel(other) }))
    await waitFor(() => {
      expect(
        view
          .getByRole('button', { name: dayCellLabel(other) })
          .element()
          .getAttribute('aria-current'),
      ).toBe('date')
    })
    expect(
      view.getByRole('button', { name: 'Today' }).element().classList.contains('opacity-100'),
    ).toBe(true)
    expect(todayButton.element().hasAttribute('inert')).toBe(false)

    await user.click(view.getByRole('button', { name: 'Today' }))
    await waitFor(() => expect(view.getByRole('button', { name: 'Today' }).query()).toBeNull())
    expect(todayButton.element().classList.contains('opacity-0')).toBe(true)
    expect(todayButton.element().hasAttribute('inert')).toBe(true)
    expect(
      view
        .getByRole('button', { name: dayCellLabel(today) })
        .element()
        .getAttribute('aria-current'),
    ).toBe('date')
  })

  it('marks dates backed by daily notes across the pageable strip window', async () => {
    const today = getIsoToday()
    const week = weekOf(today, 'monday')
    const notedDay = week.find((day) => day !== today) ?? week[0]!
    const emptyDay = week.find((day) => day !== today && day !== notedDay) ?? week[1]!
    dailyDatesInRange.mockResolvedValue([notedDay])

    const view = await mount({ kind: 'today' })

    await expect.element(view.getByTestId(`note-dot-${notedDay}`)).toBeVisible()
    await expect.element(view.getByTestId(`note-dot-${emptyDay}`)).not.toBeInTheDocument()
    await expect
      .element(
        view.getByRole('button', {
          name: `${dayCellLabel(notedDay)}, has daily note`,
        }),
      )
      .toBeVisible()

    const weekWindow = createWeekWindow(today, 'monday')
    expect(dailyDatesInRange).toHaveBeenCalledWith(
      weekWindow.start,
      addDaysToIsoDate(weekWindow.start, weekWindow.count * 7 - 1),
    )
  })

  it('selects a day in another week straight from the pageable strip', async () => {
    const today = getIsoToday()
    // Two weeks out: its cell lives on a different week slide of the strip,
    // which the strip renders (and pages) rather than a single week.
    const nextFortnight = addDaysToIsoDate(today, 14)
    const view = await mount({ kind: 'today' })

    await fireClick(view.getByRole('button', { name: dayCellLabel(nextFortnight) }).element())
    await expect
      .element(view.getByRole('button', { name: dayCellLabel(nextFortnight) }))
      .toHaveAttribute('aria-current', 'date')
    expect(shownMonth(view)).toBe(formatMonthLabel(getYearMonth(nextFortnight)))
    await expect.element(view.getByRole('button', { name: 'Today' })).toBeVisible()
  })

  it('jumps to a month picked from the month title', async () => {
    const today = getIsoToday()
    const view = await mount({ kind: 'today' })

    // January next year: always a different month, and (unlike a fixed
    // offset) always the same distance shape from today — date-agnostic.
    const pickedMonth = `${Number(getYearMonth(today).slice(0, 4)) + 1}-01`
    await pickMonthFromTitle(view, pickedMonth)

    await waitFor(() => expect(shownMonth(view)).toBe(formatMonthLabel(pickedMonth)))
    const firstDay = `${pickedMonth}-01`
    expect(
      view
        .getByRole('button', { name: dayCellLabel(firstDay) })
        .element()
        .getAttribute('aria-current'),
    ).toBe('date')
    await expect.element(view.getByRole('button', { name: 'Today' })).toBeVisible()
  })

  it('keeps the selection when its own month is picked from the month title', async () => {
    const today = getIsoToday()
    const view = await mount({ kind: 'today' })

    await pickMonthFromTitle(view, getYearMonth(today))

    await waitFor(() => {
      expect(
        view
          .getByRole('button', { name: dayCellLabel(today) })
          .element()
          .getAttribute('aria-current'),
      ).toBe('date')
    })
    expect(view.getByRole('button', { name: 'Today' }).query()).toBeNull()
  })

  it('fires haptics from the Daily header Today and Settings buttons', async () => {
    const user = userEvent
    const today = getIsoToday()
    const other = otherDayInWeek(today)
    const view = await mount({ kind: 'today' })

    await user.click(view.getByRole('button', { name: dayCellLabel(other) }))
    core.mobile.haptics.reset()

    await user.click(view.getByRole('button', { name: 'Today' }))
    expect(core.mobile.haptics.impacts()).toBe(1)

    await user.click(view.getByRole('button', { name: 'Settings' }))
    expect(core.mobile.haptics.impacts()).toBe(2)
    await expect.element(view.getByRole('heading', { name: 'Settings' })).toBeVisible()
  })

  it('re-anchors the carousel when a date link lands outside its window', async () => {
    const user = userEvent
    // Beyond the ±366-day window — only reachable as a date-link navigation,
    // which forces the carousel to rebuild its window around the day.
    const farDay = addDaysToIsoDate(getIsoToday(), 400)
    core.noteFile.set(`daily/${farDay}.md`, 'far future plans')
    const view = await mount({ kind: 'today' }, { kind: 'daily', date: farDay })

    await user.click(view.getByRole('button', { name: 'probe-navigate' }))
    await waitFor(() => expect(shownMonth(view)).toBe(formatMonthLabel(getYearMonth(farDay))))
    await waitFor(() => {
      const editors = view.getByTestId('fake-editor').elements()
      expect(editors.some((editor) => editor.textContent?.includes('far future plans'))).toBe(true)
    })
  })

  it('opens a note from in-screen navigation and pops back through history', async () => {
    const user = userEvent
    core.noteFile.set('notes/meeting-notes.md', 'agenda')
    const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })

    await user.click(view.getByRole('button', { name: 'probe-navigate' }))
    await waitFor(() => expect(view.getByRole('heading').element().textContent).toBe('Edit note'))

    await user.click(view.getByRole('button', { name: 'Back' }))
    await waitFor(() => {
      return expect(shownMonth(view)).toBe(formatMonthLabel(getYearMonth(getIsoToday())))
    })
  })

  it('never focuses the destination editor on navigation (keyboard stays down)', async () => {
    const user = userEvent
    core.noteFile.set('notes/source.md', 'see [[Target Note]]')
    const view = await mount({ kind: 'note', path: 'notes/source.md' })

    // A plain arrival (cold entry, All list, back-nav) must not focus — on
    // touch that would raise the keyboard while browsing. (The stack keeps
    // today's spine mounted beneath the note, so scope to the visible layer.)
    await waitFor(() => {
      expect(
        page.elementLocator(visibleLayer(view)).getByTestId('fake-editor').element().textContent,
      ).toContain('see [[Target Note]]')
    })
    expect(editorProbe.focusCalls).toBe(0)

    // The tap resolves (unresolved title → create-from-unresolved) and
    // navigates, but the destination must NOT focus: the keyboard raise
    // would cut through the stack push animation — end to end through the
    // real router, NotePane, and document pipeline.
    await user.click(view.getByRole('button', { name: 'fake-wikilink' }))
    await waitFor(() => {
      expect(view.getByRole('heading').element().textContent).not.toContain('source')
    })
    await waitFor(() => {
      expect(
        page.elementLocator(visibleLayer(view)).getByTestId('fake-editor').query(),
      ).not.toBeNull()
    })
    expect(editorProbe.focusCalls).toBe(0)
    expect(editorProbe.selectionCalls).toEqual([])
  })

  it('switches tabs: All shows the searchable list, Daily returns to the last-open day', async () => {
    const user = userEvent
    const today = getIsoToday()
    const other = otherDayInWeek(today)
    const view = await mount({ kind: 'today' })

    await user.click(view.getByRole('button', { name: dayCellLabel(other) }))
    await waitFor(() => {
      expect(
        view
          .getByRole('button', { name: dayCellLabel(other) })
          .element()
          .getAttribute('aria-current'),
      ).toBe('date')
    })

    await user.click(view.getByRole('button', { name: 'All' }))
    await expect.element(view.getByRole('searchbox', { name: 'Search notes' })).toBeVisible()
    await expect.element(view.getByText('No notes yet')).toMatchTextContent('No notes yet')

    await user.click(view.getByRole('button', { name: 'Daily', exact: true }))
    await waitFor(
      () => {
        expect(
          view
            .getByRole('button', { name: dayCellLabel(other) })
            .element()
            .getAttribute('aria-current'),
        ).toBe('date')
      },
      { timeout: 10_000 },
    )
  })

  it('double-tapping Daily opens today and focuses the daily editor at its end', async () => {
    const user = userEvent
    const today = getIsoToday()
    const other = otherDayInWeek(today)
    const view = await mount({ kind: 'today' })

    await user.click(view.getByRole('button', { name: dayCellLabel(other) }))
    await user.click(view.getByRole('button', { name: 'All' }))
    await expect.element(view.getByRole('searchbox', { name: 'Search notes' })).toBeVisible()

    let fakeNow = 1_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)

    await fireClick(view.getByRole('button', { name: 'Daily', exact: true }).element())
    expect(
      view
        .getByRole('button', { name: dayCellLabel(other) })
        .element()
        .getAttribute('aria-current'),
    ).toBe('date')

    fakeNow = 1_100
    await fireClick(view.getByRole('button', { name: 'Daily', exact: true }).element())
    now.mockRestore()
    await waitFor(() => {
      expect(
        view
          .getByRole('button', { name: dayCellLabel(today) })
          .element()
          .getAttribute('aria-current'),
      ).toBe('date')
    })
    // The capture gesture: focus with the caret at the end of today's content.
    await waitFor(() => {
      expect(editorProbe.focusCalls).toBe(1)
    })
    expect(editorProbe.selectionCalls).toEqual(['end'])
  })

  it('double-tapping Daily while already on today focuses the editor at its end', async () => {
    const today = getIsoToday()
    core.noteFile.set(`daily/${today}.md`, 'first thought')
    const view = await mount({ kind: 'today' })
    await waitFor(() => {
      const editors = view.getByTestId('fake-editor').elements()
      expect(editors.some((editor) => editor.textContent?.includes('first thought'))).toBe(true)
    })

    let fakeNow = 1_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)
    await fireClick(view.getByRole('button', { name: 'Daily', exact: true }).element())
    fakeNow = 1_100
    await fireClick(view.getByRole('button', { name: 'Daily', exact: true }).element())
    now.mockRestore()

    // A date-preserving focus arrival: the caret lands at the end (the
    // re-anchor-to-top of a plain re-arrival must not fire over it).
    await waitFor(() => {
      expect(editorProbe.focusCalls).toBe(1)
    })
    expect(editorProbe.selectionCalls).toEqual(['end'])
  })

  it('does not jump to today on a single tap of the active Daily tab', async () => {
    const user = userEvent
    const today = getIsoToday()
    const other = otherDayInWeek(today)
    const view = await mount({ kind: 'daily', date: other })

    await user.click(view.getByRole('button', { name: 'Daily', exact: true }))
    await waitFor(() => {
      expect(
        view
          .getByRole('button', { name: dayCellLabel(other) })
          .element()
          .getAttribute('aria-current'),
      ).toBe('date')
    })
    expect(
      view
        .getByRole('button', { name: dayCellLabel(today) })
        .element()
        .getAttribute('aria-current'),
    ).not.toBe('date')
    expect(editorProbe.focusCalls).toBe(0)
  })

  it('switches to the Tasks tab, which renders the grouped task list', async () => {
    const user = userEvent
    const view = await mount({ kind: 'today' })

    await user.click(view.getByRole('button', { name: 'Tasks' }))
    await expect.element(view.getByRole('searchbox', { name: 'Search tasks' })).toBeVisible()
    // The fake bridge's index is empty, so the tab lands on its empty state.
    await expect.element(view.getByText('No tasks to show')).toMatchTextContent('No tasks to show')
  })

  it('double-tapping Tasks selects the task search filter', async () => {
    const user = userEvent
    let fakeNow = 1_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)
    const view = await mount({ kind: 'today' })
    let box: HTMLInputElement | null = null

    try {
      fireEvent.click(view.getByRole('button', { name: 'Tasks' }))
      const boxLocator = view.getByRole('searchbox', { name: 'Search tasks' })
      await expect.element(boxLocator).toBeVisible()
      box = boxLocator.element() as HTMLInputElement
      await user.type(box, 'milk')

      fakeNow = 2_000
      fireEvent.click(view.getByRole('button', { name: 'Tasks' }))
      fakeNow = 2_100
      fireEvent.click(view.getByRole('button', { name: 'Tasks' }))
    } finally {
      now.mockRestore()
    }

    if (box === null) {
      throw new Error('task search box did not render')
    }
    await waitFor(() => {
      expect(document.activeElement).toBe(box)
      expect(box.selectionStart).toBe(0)
      expect(box.selectionEnd).toBe(box.value.length)
    })
  })

  it('hides the tab bar while the software keyboard is up (V1: the keyboard covered it)', async () => {
    const view = await mount({ kind: 'today' })
    await expect.element(view.getByRole('navigation', { name: 'Sections' })).toBeVisible()

    await act(() => appServices.keyboard.publish(316))
    expect(view.getByRole('navigation', { name: 'Sections' }).query()).toBeNull()

    await act(() => appServices.keyboard.publish(0))
    await expect.element(view.getByRole('navigation', { name: 'Sections' })).toBeVisible()
  })

  it('gives the tab bar slot to the formatting toolbar only while an editor is focused', async () => {
    const view = await mount({ kind: 'today' })
    const owner = Symbol('shell-test')

    // Keyboard up with no focused editor (the All-tab search field): neither
    // the tab bar nor a dead-button toolbar.
    await act(() => appServices.keyboard.publish(316))
    expect(view.getByRole('toolbar', { name: 'Formatting' }).query()).toBeNull()

    await act(() => {
      publishFormattingToolbar(owner, {
        capabilities: {
          canIndent: true,
          canDedent: false,
          canMoveUp: true,
          canMoveDown: true,
          canAttachFiles: false,
        },
        commands: {
          cycleBulletOrderedList: vi.fn(),
          cycleCheckableList: vi.fn(),
          indent: vi.fn(),
          dedent: vi.fn(),
          moveUp: vi.fn(),
          moveDown: vi.fn(),
          insertTrigger: vi.fn(),
          dismissKeyboard: vi.fn(),
          attachFiles: vi.fn(),
          scrollCaretIntoView: vi.fn(),
        },
      })
    })
    await expect.element(view.getByRole('toolbar', { name: 'Formatting' })).toBeVisible()
    expect(view.getByRole('navigation', { name: 'Sections' }).query()).toBeNull()

    await act(() => {
      clearFormattingToolbar(owner)
      appServices.keyboard.publish(0)
    })
    expect(view.getByRole('toolbar', { name: 'Formatting' }).query()).toBeNull()
    await expect.element(view.getByRole('navigation', { name: 'Sections' })).toBeVisible()
  })

  it('has three tabs: Daily, All and Tasks (Chat lives in All)', async () => {
    const view = await mount({ kind: 'today' })

    const tabs = view.getByRole('navigation', { name: 'Sections' }).getByRole('button')
    expect(tabs.elements().map((tab) => tab.getAttribute('aria-label'))).toEqual([
      'Daily',
      'All',
      'Tasks',
    ])
  })

  /**
   * The All tab over services with one configured AI provider, whose chat
   * engine (returned for its call log) answers every turn with `reply`.
   */
  async function mountAllWithChatProvider(reply: string) {
    const model: AiProviderConfig = {
      id: 'm1',
      provider: 'openai',
      model: 'gpt-5.1',
      keyHint: '12345',
    }
    const chatEngine = createTestChatEngineService([
      { type: 'text-delta', text: reply },
      { type: 'complete', messages: [{ role: 'assistant', content: reply }] },
    ])
    core = createTestCoreServices({
      database: createWasmTestDatabaseService(),
      secretStore: createTestSecretStoreService({ [aiKeySecretName(model.id)]: 'sk-test' }),
      chatEngine,
    })
    appServices = createTestAppServices(core)
    core.clock.setNow(Date.now())
    appServices.systemPreferences.reducedMotion.set(true)
    const view = await mount({ kind: 'allNotes', tag: null }, undefined, {
      settings: { aiProviders: [model], defaultAiProviderId: model.id },
    })
    return { view, chatEngine }
  }

  /** Wait for the lazy Chat screen to become the visible layer. */
  async function waitForChatLayer(view: BrowserView): Promise<void> {
    await waitFor(() => {
      expect(visibleLayer(view).querySelector('h1')?.textContent).toBe('Chat')
    })
  }

  it('Quick Open shows the results over the screen and ⌘Return lands on All', async () => {
    const view = await mount({ kind: 'today' })
    await act(() => quickOpenVisible.set(true))
    const input = view.getByRole('searchbox', { name: 'Quick Open' })
    await userEvent.fill(input, 'meeting')
    await expect.element(view.getByRole('button', { name: 'See all in All ⌘↩' })).toBeVisible()

    await userEvent.keyboard('{Meta>}{Enter}{/Meta}')

    expect(view.getByRole('dialog', { name: 'Quick Open' }).query()).toBeNull()
    const box = view.getByRole('searchbox', { name: 'Search notes' })
    await waitFor(() => {
      expect((box.element() as HTMLInputElement).value).toBe('meeting')
    })
    expect(view.getByRole('button', { name: 'All' }).element().getAttribute('aria-current')).toBe(
      'page',
    )
  })

  it('Quick Open closes on Escape and leaves the screen as it was', async () => {
    const view = await mount({ kind: 'tasks' })
    await act(() => quickOpenVisible.set(true))
    await expect.element(view.getByRole('searchbox', { name: 'Quick Open' })).toHaveFocus()

    await userEvent.keyboard('{Escape}')

    expect(view.getByRole('dialog', { name: 'Quick Open' }).query()).toBeNull()
    expect(view.getByRole('button', { name: 'Tasks' }).element().getAttribute('aria-current')).toBe(
      'page',
    )
  })

  it('with no AI provider, the Ask row leads to Settings', async () => {
    const view = await mount({ kind: 'allNotes', tag: null })
    const box = view.getByRole('searchbox', { name: 'Search notes' })
    await userEvent.fill(box, 'pricing')
    await expect.element(view.getByText('Add an AI provider in Settings to ask')).toBeVisible()

    await userEvent.click(view.getByRole('button', { name: /^Ask “pricing”/ }))

    await waitFor(() => {
      expect(visibleLayer(view).querySelector('h1')?.textContent).toBe('Settings')
    })
  })

  it('asks the search text from All: Chat opens over All, Back returns to the results', async () => {
    const user = userEvent
    const { view, chatEngine } = await mountAllWithChatProvider('You kept one plan.')

    const box = view.getByRole('searchbox', { name: 'Search notes' })
    await expect.element(box).toBeVisible()
    // Nothing typed, nothing to ask.
    expect(view.getByRole('button', { name: /^Ask/ }).query()).toBeNull()

    await user.fill(box, 'pricing')
    await user.click(view.getByRole('button', { name: /^Ask “pricing”/ }))

    await waitForChatLayer(view)
    const chat = page.elementLocator(visibleLayer(view))
    // The typed text is the question sent, not just a trigger for any turn.
    await expect.element(chat.getByText('pricing', { exact: true })).toBeVisible()
    expect(chatEngine.calls()[0]?.messages.at(-1)).toMatchObject({
      role: 'user',
      content: 'pricing',
    })
    await expect.element(chat.getByText('You kept one plan.')).toBeVisible()
    // Pushed over All, like a note: the All tab stays the current one.
    expect(view.getByRole('button', { name: 'All' }).element().getAttribute('aria-current')).toBe(
      'page',
    )

    await user.click(chat.getByRole('button', { name: 'Back' }))

    await waitFor(() => {
      expect((box.element() as HTMLInputElement).value).toBe('pricing')
      expect(visibleLayer(view).contains(box.element())).toBe(true)
    })
    // The header's Chat button now resumes that conversation.
    await expect.element(view.getByTestId('chat-in-progress')).toBeInTheDocument()

    // A second tap on the same Ask reopens that answer instead of paying for
    // the question twice.
    await user.click(view.getByRole('button', { name: /^Ask “pricing”/ }))
    await waitForChatLayer(view)
    expect(chatEngine.calls()).toHaveLength(1)
  })

  it('opens an empty Chat from All’s Chat button with the composer focused', async () => {
    const user = userEvent
    const { view } = await mountAllWithChatProvider('unused')
    // No conversation yet, so nothing to mark as in progress.
    expect(view.getByTestId('chat-in-progress').query()).toBeNull()

    await user.click(view.getByRole('button', { name: 'Chat', exact: true }))

    await waitForChatLayer(view)
    const composer = page.elementLocator(visibleLayer(view)).getByLabelText('Chat message')
    await waitFor(() => expect(document.activeElement).toBe(composer.element()))
  })

  it('tapping All from another tab returns to the Chat it was left on, over the list', async () => {
    const user = userEvent
    const { view, chatEngine } = await mountAllWithChatProvider('You kept one plan.')
    await user.fill(view.getByRole('searchbox', { name: 'Search notes' }), 'pricing')
    await user.click(view.getByRole('button', { name: /^Ask “pricing”/ }))
    await waitForChatLayer(view)

    await user.click(view.getByRole('button', { name: 'Daily', exact: true }))
    await waitFor(() => expect(shownMonth(view)).not.toBeNull())
    await user.click(view.getByRole('button', { name: 'All' }))

    await waitForChatLayer(view)
    const chat = page.elementLocator(visibleLayer(view))
    await expect.element(chat.getByText('You kept one plan.')).toBeVisible()
    // A return, not a second ask, and the restored card belongs to All.
    expect(chatEngine.calls()).toHaveLength(1)
    expect(view.getByRole('button', { name: 'All' }).element().getAttribute('aria-current')).toBe(
      'page',
    )

    // All's list sits underneath, so Back lands there rather than on Daily.
    await user.click(chat.getByRole('button', { name: 'Back' }))
    const box = view.getByRole('searchbox', { name: 'Search notes' })
    await waitFor(() => {
      expect(visibleLayer(view).contains(box.element())).toBe(true)
      expect((box.element() as HTMLInputElement).value).toBe('pricing')
    })
  })

  it('double-tapping All from another tab goes back to the list, search focused', async () => {
    const user = userEvent
    const { view } = await mountAllWithChatProvider('You kept one plan.')
    await user.fill(view.getByRole('searchbox', { name: 'Search notes' }), 'pricing')
    await user.click(view.getByRole('button', { name: /^Ask “pricing”/ }))
    await waitForChatLayer(view)
    await user.click(view.getByRole('button', { name: 'Daily', exact: true }))
    await waitFor(() => expect(shownMonth(view)).not.toBeNull())

    let fakeNow = 1_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)
    try {
      fakeNow = 2_000
      fireEvent.click(view.getByRole('button', { name: 'All' }))
      // The first tap returns to Chat; the second, within the window, still
      // pairs with it even though that return left All's list.
      await waitForChatLayer(view)
      fakeNow = 2_100
      fireEvent.click(view.getByRole('button', { name: 'All' }))
    } finally {
      now.mockRestore()
    }

    const box = view.getByRole('searchbox', { name: 'Search notes' })
    await waitFor(() => {
      expect(visibleLayer(view).contains(box.element())).toBe(true)
      expect(document.activeElement).toBe(box.element())
    })
  })

  it('returns to a note opened from All at its new path after the file moves', async () => {
    const user = userEvent
    core.noteFile.set('notes/01abc.md', 'old path')
    const view = await mount(
      { kind: 'allNotes', tag: null },
      { kind: 'note', path: 'notes/01abc.md' },
    )
    await user.click(view.getByRole('button', { name: 'probe-navigate' }))
    await expect.element(view.getByRole('heading', { name: 'Edit note' })).toBeVisible()

    await user.click(view.getByRole('button', { name: 'Daily', exact: true }))
    await waitFor(() => expect(shownMonth(view)).not.toBeNull())
    core.noteFile.set('notes/meeting-notes.md', 'moved agenda')
    await act(() => core.noteMove.followHealedMove('notes/01abc.md', 'notes/meeting-notes.md'))
    await user.click(view.getByRole('button', { name: 'All' }))

    await waitFor(() => {
      expect(
        page.elementLocator(visibleLayer(view)).getByTestId('fake-editor').element().textContent,
      ).toContain('moved agenda')
    })
  })

  it('returns to the list when the note opened from All was trashed', async () => {
    const user = userEvent
    core.noteFile.set('notes/meeting-notes.md', 'agenda')
    const view = await mount(
      { kind: 'allNotes', tag: null },
      { kind: 'note', path: 'notes/meeting-notes.md' },
    )
    await user.click(view.getByRole('button', { name: 'probe-navigate' }))
    await expect.element(view.getByRole('heading', { name: 'Edit note' })).toBeVisible()

    await user.click(view.getByRole('button', { name: 'Daily', exact: true }))
    await waitFor(() => expect(shownMonth(view)).not.toBeNull())
    await act(() => core.noteActions.trashOne('notes/meeting-notes.md'))
    await user.click(view.getByRole('button', { name: 'All' }))

    const box = view.getByRole('searchbox', { name: 'Search notes' })
    await waitFor(() => expect(visibleLayer(view).contains(box.element())).toBe(true))
  })

  it('tapping Tasks from another tab returns to the note it was left on, over the list', async () => {
    const user = userEvent
    core.noteFile.set('notes/meeting-notes.md', 'agenda')
    const view = await mount({ kind: 'tasks' }, { kind: 'note', path: 'notes/meeting-notes.md' })
    await user.click(view.getByRole('button', { name: 'probe-navigate' }))
    await expect.element(view.getByRole('heading', { name: 'Edit note' })).toBeVisible()

    await user.click(view.getByRole('button', { name: 'Daily', exact: true }))
    await waitFor(() => expect(shownMonth(view)).not.toBeNull())
    await user.click(view.getByRole('button', { name: 'Tasks' }))

    await waitFor(() => {
      expect(
        page.elementLocator(visibleLayer(view)).getByTestId('fake-editor').element().textContent,
      ).toContain('agenda')
    })
    expect(view.getByRole('button', { name: 'Tasks' }).element().getAttribute('aria-current')).toBe(
      'page',
    )
    // The task list sits underneath, so Back lands there.
    await user.click(page.elementLocator(visibleLayer(view)).getByRole('button', { name: 'Back' }))
    const box = view.getByRole('searchbox', { name: 'Search tasks' })
    await waitFor(() => expect(visibleLayer(view).contains(box.element())).toBe(true))
  })

  it('keeps the Tasks search when switching tabs and back', async () => {
    const user = userEvent
    const view = await mount({ kind: 'tasks' })
    await user.fill(view.getByRole('searchbox', { name: 'Search tasks' }), 'milk')

    await user.click(view.getByRole('button', { name: 'All' }))
    await expect.element(view.getByRole('searchbox', { name: 'Search notes' })).toBeVisible()
    await user.click(view.getByRole('button', { name: 'Tasks' }))

    await expect.element(view.getByRole('searchbox', { name: 'Search tasks' })).toHaveValue('milk')
  })

  it('restores the All list scroll when switching tabs and back', async () => {
    const user = userEvent
    vi.spyOn(core.search, 'searchWithFilters').mockResolvedValue(
      Array.from({ length: 40 }, (_, index) => ({
        path: `notes/note-${index}.md`,
        title: `Note ${index}`,
        highlightedTitle: `Note ${index}`,
        dailyDate: null,
        snippet: null,
        preview: '',
        mtime: 0,
        isPinned: false,
      })),
    )
    const view = await mount({ kind: 'allNotes', tag: null })
    const list = (): HTMLElement => {
      return visibleLayer(view).querySelector<HTMLElement>('ul')!.parentElement!
    }
    await waitFor(() => expect(list().scrollHeight).toBeGreaterThan(list().clientHeight + 300))
    await scrollElement({ element: list(), top: 300 })

    await user.click(view.getByRole('button', { name: 'Tasks' }))
    await expect.element(view.getByRole('searchbox', { name: 'Search tasks' })).toBeVisible()
    await user.click(view.getByRole('button', { name: 'All' }))

    await waitFor(() => expect(list().scrollTop).toBe(300))
  })

  it('back from a cold note entry lands on today', async () => {
    const user = userEvent
    core.noteFile.set('notes/meeting-notes.md', 'agenda')
    const view = await mount({ kind: 'note', path: 'notes/meeting-notes.md' })

    expect(view.getByRole('heading').element().textContent).toBe('Edit note')
    await waitFor(() => {
      expect(
        page.elementLocator(visibleLayer(view)).getByTestId('fake-editor').element().textContent,
      ).toContain('agenda')
    })

    await user.click(view.getByRole('button', { name: 'Back' }))
    await waitFor(() => {
      return expect(shownMonth(view)).toBe(formatMonthLabel(getYearMonth(getIsoToday())))
    })
  })
})

/**
 * The navigation stack (V1 parity): a pushed note slides in as a card over
 * its origin (which stays mounted, hidden, and inert beneath it), popping
 * slides it out, and tab switches stay instant. The layers are pages of a
 * horizontal scroller, the current one last, and an edge back-swipe scrolls
 * it. Tests finish the animations by hand, scroll the pager as
 * a finger would, and read which screen the router lands on.
 */
describe('MobileStack transitions & back pager', () => {
  // The file prefers reduced motion, which turns the stack's animations off.
  // These tests are about the animated path, so they prefer full motion; the
  // reduced-motion test below sets the other answer for itself.
  beforeEach(async () => {
    await emulateReducedMotion(false)
    appServices.systemPreferences.reducedMotion.set(false)
  })

  /** Navigate to the probe note and complete the push animation. */
  async function pushProbeNote(view: BrowserView): Promise<void> {
    const user = userEvent
    await user.click(view.getByRole('button', { name: 'probe-navigate' }))
    await finishStackAnimations(view)
  }

  function pager(view: BrowserView): HTMLElement {
    const element = view.container.querySelector<HTMLElement>('.mobile-pager')
    if (!element) {
      throw new Error('no mobile pager')
    }
    return element
  }

  /**
   * The pager's offset when it rests on the current page.
   */
  function restLeft(element: HTMLElement): number {
    return element.scrollWidth - element.clientWidth
  }

  const today = (): string => formatMonthLabel(getYearMonth(getIsoToday()))

  it('pushes a note as a sliding card over its origin, which stays mounted but inert', async () => {
    const user = userEvent
    core.noteFile.set('notes/meeting-notes.md', 'agenda')
    const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })

    await user.click(view.getByRole('button', { name: 'probe-navigate' }))
    await waitFor(() => expect(stackLayers(view)).toHaveLength(2))
    const layers = stackLayers(view)
    const [origin, entering] = layers
    expect(entering!.className).toContain('mobile-stack-slide-in')
    expect(origin!.getAttribute('aria-hidden')).toBe('true')
    expect(
      page.elementLocator(origin!).locate('h1').element().querySelector('[data-slot="month-title"]')
        ?.textContent,
    ).toBe(formatMonthLabel(getYearMonth(getIsoToday())))
    expect(view.container.querySelector('.mobile-stack-scrim')).toBeTruthy()

    await finishStackAnimations(view)
    // The animation class clears; the origin stays mounted for the back-swipe.
    expect(entering!.className).not.toContain('mobile-stack-slide-in')
    expect(stackLayers(view)).toHaveLength(2)
  })

  it('pops the note with a slide-out and unmounts it when the animation ends', async () => {
    const user = userEvent
    core.noteFile.set('notes/meeting-notes.md', 'agenda')
    const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })
    await pushProbeNote(view)

    await user.click(view.getByRole('button', { name: 'Back' }))
    // Daily is current again immediately; the note lingers only to animate out.
    await waitFor(() => {
      return expect(shownMonth(view)).toBe(formatMonthLabel(getYearMonth(getIsoToday())))
    })
    const exiting = stackLayers(view).at(-1)!
    expect(exiting.className).toContain('mobile-stack-slide-out')
    expect(exiting.getAttribute('aria-hidden')).toBe('true')

    await finishStackAnimations(view)
    expect(stackLayers(view)).toHaveLength(1)
  })

  it('keeps tab switches instant: one layer, no slide (V1 cross-fade at most)', async () => {
    const user = userEvent
    const view = await mount({ kind: 'today' })
    expect(stackLayers(view)).toHaveLength(1)

    await user.click(view.getByRole('button', { name: 'All' }))
    await expect.element(view.getByRole('searchbox', { name: 'Search notes' })).toBeVisible()
    const layers = stackLayers(view)
    expect(layers).toHaveLength(1)
    expect(layers[0]!.className).not.toContain('mobile-stack-slide-in')
    expect(view.container.querySelector('.mobile-stack-scrim')).toBeNull()
  })

  it('leaves All’s open note for another tab in place, without a slide-out', async () => {
    const user = userEvent
    core.noteFile.set('notes/meeting-notes.md', 'agenda')
    const view = await mount(
      { kind: 'allNotes', tag: null },
      { kind: 'note', path: 'notes/meeting-notes.md' },
    )
    await expect.element(view.getByRole('searchbox', { name: 'Search notes' })).toBeVisible()
    await pushProbeNote(view)

    await user.click(view.getByRole('button', { name: 'Tasks' }))

    await waitFor(() => expect(stackLayers(view)).toHaveLength(1))
    expect(view.container.querySelector('.mobile-stack-slide-out')).toBeNull()
  })

  it('returns to All’s open note in place, over the list, like any tab switch', async () => {
    const user = userEvent
    core.noteFile.set('notes/meeting-notes.md', 'agenda')
    const view = await mount(
      { kind: 'allNotes', tag: null },
      { kind: 'note', path: 'notes/meeting-notes.md' },
    )
    // All is lazy: let its list mount before pushing the note over it.
    await expect.element(view.getByRole('searchbox', { name: 'Search notes' })).toBeVisible()
    await pushProbeNote(view)
    await user.click(view.getByRole('button', { name: 'Daily', exact: true }))
    await finishStackAnimations(view)
    await waitFor(() => expect(stackLayers(view)).toHaveLength(1))

    await user.click(view.getByRole('button', { name: 'All' }))

    await waitFor(() => expect(stackLayers(view)).toHaveLength(2))
    const [below, current] = stackLayers(view)
    expect(current!.className).not.toContain('mobile-stack-slide-in')
    // Hidden and inert beneath the note, so read the DOM, not the a11y tree.
    expect(below!.querySelector('input[aria-label="Search notes"]')).not.toBeNull()
    await waitFor(() => {
      expect(
        page.elementLocator(current!).getByTestId('fake-editor').element().textContent,
      ).toContain('agenda')
    })
    expect(view.getByRole('button', { name: 'All' }).element().getAttribute('aria-current')).toBe(
      'page',
    )

    // Tapping All again, on its card, pops back to the list.
    await user.click(view.getByRole('button', { name: 'All' }))
    await finishStackAnimations(view)
    await waitFor(() => {
      expect(stackLayers(view)).toHaveLength(1)
      expect(stackLayers(view)[0]!.querySelector('input[aria-label="Search notes"]')).not.toBeNull()
    })
  })

  it('follows history direction within a note chain: wiki-link pushes, back pops', async () => {
    const user = userEvent
    core.noteFile.set('notes/source.md', 'see [[Target Note]]')
    const view = await mount({ kind: 'note', path: 'notes/source.md' })
    await waitFor(() => {
      expect(
        page.elementLocator(visibleLayer(view)).getByTestId('fake-editor').element().textContent,
      ).toContain('Target Note')
    })

    await user.click(view.getByRole('button', { name: 'fake-wikilink' }))
    // Deeper into the chain: the destination slides in over the source.
    await waitFor(() => {
      expect(stackLayers(view).at(-1)!.className).toContain('mobile-stack-slide-in')
    })
    await finishStackAnimations(view)

    await user.click(view.getByRole('button', { name: 'Back' }))
    // Popping reveals the still-mounted source, re-seats today beneath it,
    // and slides the destination out — three layers, briefly.
    await waitFor(() => expect(stackLayers(view)).toHaveLength(3))
    const layers = stackLayers(view)
    expect(layers.at(-1)!.className).toContain('mobile-stack-slide-out')
    expect(page.elementLocator(visibleLayer(view)).getByRole('heading').element().textContent).toBe(
      'Edit note',
    )
    await finishStackAnimations(view)
    expect(stackLayers(view)).toHaveLength(2)
  })

  it('cuts instantly under prefers-reduced-motion', async () => {
    await emulateReducedMotion(true)
    appServices.systemPreferences.reducedMotion.set(true)
    const user = userEvent
    core.noteFile.set('notes/meeting-notes.md', 'agenda')
    const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })

    await user.click(view.getByRole('button', { name: 'probe-navigate' }))
    await waitFor(() => expect(view.getByRole('heading').element().textContent).toBe('Edit note'))
    expect(stackLayers(view).at(-1)!.className).not.toContain('mobile-stack-slide-in')

    await user.click(view.getByRole('button', { name: 'Back' }))
    // No exit animation: the note is gone the moment the route changes.
    await waitFor(() => {
      return expect(shownMonth(view)).toBe(formatMonthLabel(getYearMonth(getIsoToday())))
    })
    expect(stackLayers(view)).toHaveLength(1)
  })

  it('rests on the pushed note, with its origin mounted on the page below', async () => {
    core.noteFile.set('notes/meeting-notes.md', 'agenda')
    const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })
    await pushProbeNote(view)

    const scroller = pager(view)
    expect(stackLayers(view)).toHaveLength(2)
    expect(scroller.scrollLeft).toBe(restLeft(scroller))
    expect(visibleLayer(view).getBoundingClientRect().left).toBe(
      scroller.getBoundingClientRect().left,
    )
    expect(stackLayers(view)[0]!.getBoundingClientRect().left).toBe(
      scroller.getBoundingClientRect().left,
    )
  })

  it('pops when a swipe settles on the page below', async () => {
    core.noteFile.set('notes/meeting-notes.md', 'agenda')
    const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })
    await pushProbeNote(view)

    await scrollElement({ element: pager(view), left: 0, touch: true })
    await waitFor(() => expect(shownMonth(view)).toBe(today()))
    expect(stackLayers(view)).toHaveLength(1)
  })

  it('waits for the finger to lift before it pops', async () => {
    core.noteFile.set('notes/meeting-notes.md', 'agenda')
    const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })
    await pushProbeNote(view)

    const scroller = pager(view)
    await touch(scroller, 'start')
    await scrollElement({ element: scroller, left: 0 })
    await sleep(200)
    expect(view.getByRole('heading').element().textContent).toBe('Edit note')

    await touch(scroller, 'end')
    await waitFor(() => expect(shownMonth(view)).toBe(today()))
  })

  it('unlocks the revealed page as soon as the finger lifts', async () => {
    core.noteFile.set('notes/meeting-notes.md', 'agenda')
    const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })
    await pushProbeNote(view)

    const scroller = pager(view)
    const [below] = stackLayers(view)
    await touch(scroller, 'start')
    await scrollElement({ element: scroller, left: 0 })
    // Outside `act`, so this reads before React commits the pop.
    dispatchTouch(scroller, 'end')
    expect(below!.inert).toBe(false)
    await waitFor(() => expect(shownMonth(view)).toBe(today()))
  })

  it('ignores a scroll no finger started and returns to the note', async () => {
    core.noteFile.set('notes/meeting-notes.md', 'agenda')
    const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })
    await pushProbeNote(view)

    const scroller = pager(view)
    await scrollElement({ element: scroller, left: 0 })
    await waitFor(() => expect(scroller.scrollLeft).toBe(restLeft(scroller)))
    expect(view.getByRole('heading').element().textContent).toBe('Edit note')
    expect(stackLayers(view)).toHaveLength(2)
  })

  it('keeps the note when the finger drags back before it lifts', async () => {
    core.noteFile.set('notes/meeting-notes.md', 'agenda')
    const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })
    await pushProbeNote(view)

    const scroller = pager(view)
    await touch(scroller, 'start')
    await scrollElement({ element: scroller, left: 0 })
    await scrollElement({ element: scroller, left: restLeft(scroller) })
    await touch(scroller, 'end')
    await sleep(200)
    expect(view.getByRole('heading').element().textContent).toBe('Edit note')
    expect(stackLayers(view)).toHaveLength(2)
  })

  it('commits a swipe pop exactly once (StrictMode, late scroll reports)', async () => {
    // today → All → note: a second pop would land on today instead of All.
    core.noteFile.set('notes/meeting-notes.md', 'agenda')
    const view = await mount(
      { kind: 'today' },
      { kind: 'note', path: 'notes/meeting-notes.md' },
      { strict: true },
    )
    await userEvent.click(view.getByRole('button', { name: 'All' }))
    await pushProbeNote(view)

    const scroller = pager(view)
    await touch(scroller, 'start')
    await scrollElement({ element: scroller, left: 0 })
    // One `act`, so the late reports arrive before React re-renders. A report
    // after the pop must neither pop again nor pin the popped note back.
    await act(async () => {
      dispatchTouch(scroller, 'end')
      await sleep(200)
      scroller.dispatchEvent(new Event('scroll'))
      scroller.dispatchEvent(new Event('scrollend'))
      expect(scroller.scrollLeft).toBe(0)
    })
    await expect.element(view.getByRole('searchbox', { name: 'Search notes' })).toBeVisible()
  })

  it('pops once the card is off screen, short of the snap point', async () => {
    core.noteFile.set('notes/meeting-notes.md', 'agenda')
    const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })
    await pushProbeNote(view)

    const scroller = pager(view)
    // Holds the scroll where a release leaves it, before the snap ends.
    scroller.style.scrollSnapType = 'none'
    await scrollElement({ element: scroller, left: BACK_PAGER_OVERSHOOT_PX / 2, touch: true })
    await waitFor(() => expect(shownMonth(view)).toBe(today()))
    scroller.style.removeProperty('scroll-snap-type')
  })

  it.each([
    { stop: 0.75, lands: 'note' },
    { stop: 0.25, lands: 'today' },
  ])(
    'scrolls a pager stopped at $stop of its range on to the $lands page',
    async ({ stop, lands }) => {
      core.noteFile.set('notes/meeting-notes.md', 'agenda')
      const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })
      await pushProbeNote(view)

      const scroller = pager(view)
      // Stands in for a touch that stops the snap: WebKit then snaps no more.
      scroller.style.scrollSnapType = 'none'
      await scrollElement({
        element: scroller,
        left: Math.round(restLeft(scroller) * stop),
        touch: true,
      })
      if (lands === 'note') {
        await waitFor(() => expect(scroller.scrollLeft).toBe(restLeft(scroller)))
        expect(view.getByRole('heading').element().textContent).toBe('Edit note')
      } else {
        await waitFor(() => expect(shownMonth(view)).toBe(today()))
      }
      scroller.style.removeProperty('scroll-snap-type')
    },
  )

  it('passes a tap on the edge strip to the back button under it', async () => {
    core.noteFile.set('notes/meeting-notes.md', 'agenda')
    const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })
    await pushProbeNote(view)

    const layer = page.elementLocator(visibleLayer(view))
    const strip = visibleLayer(view).querySelector<HTMLElement>('[data-pager-edge]')!
    const back = layer.getByRole('button', { name: 'Back' }).element().getBoundingClientRect()
    const top = strip.getBoundingClientRect().top
    await userEvent.click(page.elementLocator(strip), {
      position: { x: 10, y: back.top - top + back.height / 2 },
    })
    await waitFor(() => expect(shownMonth(view)).toBe(today()))
  })

  /**
   * Drags the real mouse from the edge strip, at the back button's height,
   * `dx` px to the right and releases it.
   */
  async function mouseDragFromStrip(view: BrowserView, dx: number): Promise<void> {
    const strip = visibleLayer(view).querySelector<HTMLElement>('[data-pager-edge]')!
    const back = page
      .elementLocator(visibleLayer(view))
      .getByRole('button', { name: 'Back' })
      .element()
      .getBoundingClientRect()
    const x = strip.getBoundingClientRect().left + 10
    const y = back.top + back.height / 2
    await mouse.move(x, y, { steps: 3 })
    await mouse.down()
    await mouse.move(x + dx, y, { steps: 5 })
    await mouse.up()
  }

  it('leaves a finger-held pager where it is when the pager resizes', async () => {
    core.noteFile.set('notes/meeting-notes.md', 'agenda')
    const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })
    await pushProbeNote(view)

    const scroller = pager(view)
    const held = Math.round(scroller.clientWidth / 3)
    // Mid-drag, nothing snaps the pager; a real finger scroll holds snapping off too.
    scroller.style.scrollSnapType = 'none'
    await touch(scroller, 'start')
    await act(async () => {
      const scrolled = new Promise((resolve) => {
        scroller.addEventListener('scroll', resolve, { once: true })
      })
      scroller.scrollLeft = held
      await scrolled
    })
    // A height change, like the keyboard closing mid-swipe.
    scroller.style.height = `${scroller.clientHeight - 40}px`
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

    expect(scroller.scrollLeft).toBe(held)
    await touch(scroller, 'end')
    scroller.style.removeProperty('scroll-snap-type')
  })

  it('pops when a mouse drags the edge strip past half', async () => {
    core.noteFile.set('notes/meeting-notes.md', 'agenda')
    const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })
    await pushProbeNote(view)

    await mouseDragFromStrip(view, Math.round(pager(view).clientWidth * 0.7))
    await waitFor(() => expect(shownMonth(view)).toBe(today()))
    expect(stackLayers(view)).toHaveLength(1)
  })

  it('snaps a short mouse drag back without passing its click to the back button', async () => {
    core.noteFile.set('notes/meeting-notes.md', 'agenda')
    const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })
    await pushProbeNote(view)

    const scroller = pager(view)
    // The drag must move the pager, so a drag that is ignored cannot pass.
    let lowest = scroller.scrollLeft
    scroller.addEventListener('scroll', () => {
      lowest = Math.min(lowest, scroller.scrollLeft)
    })
    await mouseDragFromStrip(view, 60)
    await waitFor(() => expect(scroller.scrollLeft).toBe(restLeft(scroller)))
    expect(lowest).toBeLessThan(restLeft(scroller) - 30)
    await sleep(200)
    expect(view.getByRole('heading').element().textContent).toBe('Edit note')
    expect(stackLayers(view)).toHaveLength(2)
  })

  it('rests on the revealed note after a note-to-note swipe pop', async () => {
    core.noteFile.set('notes/source.md', 'see [[Target Note]]')
    const view = await mount({ kind: 'note', path: 'notes/source.md' })
    await userEvent.click(view.getByRole('button', { name: 'fake-wikilink' }))
    await finishStackAnimations(view)

    await scrollElement({ element: pager(view), left: 0, touch: true })
    // The source becomes current over a freshly mounted today.
    await waitFor(
      () => {
        expect(
          page.elementLocator(visibleLayer(view)).getByTestId('fake-editor').element().textContent,
        ).toContain('Target Note')
      },
      { timeout: 5000 },
    )
    expect(stackLayers(view)).toHaveLength(2)
    const scroller = pager(view)
    expect(scroller.scrollLeft).toBe(restLeft(scroller))
  })

  /**
   * Scrolls `element` into view and drags one finger horizontally by `dx`
   * from near its left edge. The touches go through the compositor, so
   * `touch-action` applies.
   */
  async function touchDrag(element: Element, dx: number): Promise<void> {
    element.scrollIntoView({ block: 'center' })
    await sleep(50)
    const session = cdp()
    const rect = element.getBoundingClientRect()
    const x = rect.left + Math.min(40, rect.width / 2)
    const y = rect.top + rect.height / 2
    const at = (offset: number) => [{ x: x + offset, y, id: 1 }]
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) })
    for (let step = 1; step <= 10; step++) {
      await sleep(16)
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: at((dx * step) / 10),
      })
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }

  it.skipIf(server.browser !== 'chromium')(
    'pops on a finger drag from a settings row, not from its switch',
    async () => {
      const view = await mount({ kind: 'settings', page: 'main' })
      const toggle = await waitFor(() => {
        return view.getByRole('switch', { name: 'Smooth caret animation' }).element()
      })
      const checked = toggle.getAttribute('aria-checked')

      await touchDrag(toggle, 300)
      await sleep(300)
      expect(pager(view).scrollLeft).toBe(restLeft(pager(view)))
      expect(toggle.getAttribute('aria-checked')).toBe(checked)

      await touchDrag(view.getByRole('button', { name: 'Add AI provider' }).element(), 300)
      await waitFor(() => expect(shownMonth(view)).toBe(today()))
    },
  )

  /**
   * Which element a finger drag from each part of a stacked screen moves:
   * the back pager, a horizontal scroller inside the screen, or nothing.
   */
  it.skipIf(server.browser !== 'chromium').each([
    { start: 'background', dx: 120, moves: 'pager' },
    { start: 'row', dx: 120, moves: 'pager' },
    { start: 'row-label', dx: 120, moves: 'pager' },
    { start: 'button', dx: 120, moves: 'nothing' },
    { start: 'switch-thumb', dx: 120, moves: 'nothing' },
    { start: 'row-switch-thumb', dx: 120, moves: 'nothing' },
    { start: 'editor-text', dx: 120, moves: 'nothing' },
    { start: 'code', dx: -120, moves: 'code' },
    { start: 'code', dx: 120, moves: 'nothing' },
    { start: 'swipe-row', dx: -120, moves: 'swipe-row' },
    { start: 'swipe-row', dx: 120, moves: 'nothing' },
  ])('moves the $moves on a drag of $dx px from the $start', async ({ start, dx, moves }) => {
    const view = await renderInApp(
      <div className="mobile-pager flex h-[600px] w-[375px] overflow-x-auto overscroll-none">
        <div className="h-full w-full shrink-0" />
        <div className="mobile-pager-content h-full w-full shrink-0">
          <main className="h-full overflow-y-auto">
            <div data-start="background" className="h-12" />
            <button type="button" data-back-swipe="on" className="block h-12 w-full">
              <span data-start="row-label">Row</span>
            </button>
            <button type="button" data-start="button" className="block h-12 w-full">
              Button
            </button>
            <button type="button" role="switch" aria-checked className="block h-12 w-full">
              <span data-start="switch-thumb">Thumb</span>
            </button>
            <label data-back-swipe="on" data-start="row" className="flex h-12">
              <span className="w-1/2">Switch row</span>
              <button type="button" role="switch" aria-checked className="w-1/2">
                <span data-start="row-switch-thumb">Thumb</span>
              </button>
            </label>
            <div contentEditable suppressContentEditableWarning>
              <p data-start="editor-text" className="h-12">
                Text
              </p>
              <pre data-scroll-x data-start="code" className="h-12 overflow-x-auto">
                {'x'.repeat(300)}
              </pre>
            </div>
            <div data-scroll-x className="flex h-12 overflow-x-auto">
              <button type="button" data-start="swipe-row" className="w-full shrink-0">
                Surface
              </button>
              <div className="w-36 shrink-0" />
            </div>
          </main>
        </div>
      </div>,
      { core, appServices, graph: GRAPH, route: { kind: 'today' } },
    )
    const find = (selector: string) => view.container.querySelector<HTMLElement>(selector)!
    const scrollers = {
      pager: find('.mobile-pager'),
      code: find('[data-start="code"]'),
      'swipe-row': find('[data-start="swipe-row"]').parentElement!,
    }
    scrollers.pager.scrollLeft = scrollers.pager.clientWidth
    const before = Object.fromEntries(
      Object.entries(scrollers).map(([name, element]) => [name, element.scrollLeft]),
    )

    await touchDrag(find(`[data-start="${start}"]`), dx)
    await sleep(300)

    const moved = Object.entries(scrollers)
      .filter(([name, element]) => Math.abs(element.scrollLeft - before[name]!) > 4)
      .map(([name]) => name)
    expect(moved).toEqual(moves === 'nothing' ? [] : [moves])
  })

  it('swipes a cold note entry back to today', async () => {
    core.noteFile.set('notes/meeting-notes.md', 'agenda')
    const view = await mount({ kind: 'note', path: 'notes/meeting-notes.md' })
    await waitFor(() => expect(stackLayers(view)).toHaveLength(2))
    expect(pager(view).scrollLeft).toBe(restLeft(pager(view)))

    await scrollElement({ element: pager(view), left: 0, touch: true })
    await waitFor(() => expect(shownMonth(view)).toBe(today()))
  })

  it('swipes a cold settings page back to Settings, where its Back lands', async () => {
    const view = await mount({ kind: 'settings', page: 'licenses' })
    await waitFor(() => expect(stackLayers(view)).toHaveLength(2))

    await scrollElement({ element: pager(view), left: 0, touch: true })
    await waitFor(() => {
      expect(view.appServices.navigation.get().route).toEqual({ kind: 'settings', page: 'main' })
    })
  })
})
