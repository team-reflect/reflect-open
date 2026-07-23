import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { format } from 'date-fns'
import { act, StrictMode, type ReactElement } from 'react'
import { setBridge } from '@reflect/core'
import {
  clearFormattingToolbar,
  publishFormattingToolbar,
} from '@/editor/formatting-toolbar-store'
import { RouterProvider, useRouter } from '@/routing/router'
import type { Route } from '@/routing/route'
import { addDaysIso, formatDayLabel, parseIsoDate, todayIso } from '@/lib/dates'
import { monthLabel, monthOf } from '@/lib/month-grid'
import { fireEvent } from '@/test-utils/fire-event'
import '@/test-utils/locator'
import { weekOf } from './calendar'
import { MobileShell } from './mobile-shell'
import { publishKeyboardHeight } from './use-keyboard'

const waitFor = vi.waitFor

/**
 * The tabbed mobile shell (Plan 19, V1 parity): the daily spine pages
 * between days, the All tab lists and searches, a note screen pops back to
 * where it came from, and a cold note entry lands on today. Drives the real
 * router → MobileShell → screens → NotePane stack over a fake IPC bridge;
 * only the ProseMirror view is stubbed, mirroring `route-content.test.tsx`.
 */

const editorProbe = vi.hoisted(() => ({
  focusCalls: 0,
  selectionCalls: [] as Array<'start' | 'end'>,
}))
const hapticImpactLight = vi.hoisted(() => vi.fn())

vi.mock('@/editor/note-editor', async () => {
  const { useEffect, useRef } = await import('react')
  return {
    NoteEditor: ({
      initialContent,
      onWikiLinkClick,
      handleRef,
    }: {
      initialContent: string
      onWikiLinkClick?: (target: string) => void
      handleRef?: (handle: import('@/editor/note-editor').NoteEditorHandle | null) => void
    }) => {
      const markdownRef = useRef(initialContent)
      useEffect(() => {
        handleRef?.({
          setMarkdown: (markdown) => {
            markdownRef.current = markdown
          },
          getMarkdown: () => markdownRef.current,
          insertMarkdown: () => {},
          focus: () => {
            editorProbe.focusCalls += 1
          },
          setSelection: (position: 'start' | 'end') => {
            editorProbe.selectionCalls.push(position)
          },
          getSelectedText: () => '',
          openSelectionMenu: () => {},
          startPendingReplacement: () => false,
          appendPendingReplacementText: () => {},
          acceptPendingReplacement: () => {},
          discardPendingReplacement: () => {},
        })
        return () => handleRef?.(null)
      }, [handleRef])
      return (
        <div data-testid="fake-editor">
          {initialContent}
          {onWikiLinkClick ? (
            <button type="button" onClick={() => onWikiLinkClick('Target Note')}>
              fake-wikilink
            </button>
          ) : null}
        </div>
      )
    },
  }
})
vi.mock('@/mobile/haptics', () => ({
  hapticImpactLight,
}))

const indexFns = vi.hoisted(() => ({
  getBacklinksWithContext: vi.fn(async () => ({
    contexts: [],
    nextCursor: null,
    indexedLinkCount: 0,
  })),
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getBacklinksWithContext: indexFns.getBacklinksWithContext,
}))
// Vaul's drag/animation is verified on-device. This passthrough
// honours `open`, so the month-picker sheet renders only once the title
// opens it.
vi.mock('@/components/ui/drawer', () => ({
  Drawer: ({ open, children }: { open?: boolean; children?: import('react').ReactNode }) =>
    open ? <div data-testid="drawer">{children}</div> : null,
  DrawerContent: ({ children }: { children?: import('react').ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children?: import('react').ReactNode }) => <h2>{children}</h2>,
  DrawerTrigger: ({ children }: { children?: import('react').ReactNode }) => <>{children}</>,
}))

vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    graph: { root: '/g', name: 'g', generation: 1 },
    indexing: false,
  }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: {
      editorMarkdownSyntax: 'hide',
      dateFormat: 'mdy',
      weekStartDay: 'monday',
      aiProviders: [],
      defaultAiProviderId: null,
      chatSystemPrompt: '',
      aiPrompts: [],
    },
    updateSettings: async () => {},
    updateSettingsWith: () => {},
  }),
}))
// The daily spine renders the audio-memo FAB; this suite is about screens,
// not recording — an unavailable memo surface keeps the FAB out of the tree.
vi.mock('@/mobile/audio-memo-provider', () => ({
  useMobileAudioMemo: () => ({
    phase: 'idle',
    elapsedMs: 0,
    level: 0,
    pendingCount: 0,
    available: false,
    error: null,
    canRetry: false,
    drawerOpen: false,
    toggle: () => {},
    stopAndSave: () => {},
    cancelRecording: () => {},
    onDrawerOpenChange: () => {},
    retry: () => {},
    discard: () => {},
  }),
}))

/** The fake graph: files behind the IPC bridge. */
let files: Record<string, string>
const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

setBridge({
  invoke: mockInvoke,
  listen: async () => () => {},
})

afterEach(async () => {
  await cleanup()
  publishKeyboardHeight(0)
})

beforeEach(async () => {
  await page.viewport(375, 700)
  files = {}
  editorProbe.focusCalls = 0
  editorProbe.selectionCalls = []
  mockInvoke.mockReset()
  hapticImpactLight.mockClear()
  mockInvoke.mockImplementation(async (command, args) => {
    if (command === 'note_read') {
      const content = files[(args as { path: string }).path]
      if (content === undefined) {
        throw { kind: 'notFound', message: 'missing' } // AppError shape
      }
      return content
    }
    if (command === 'note_write') {
      const { path, contents } = args as { path: string; contents: string }
      files[path] = contents
      return null
    }
    if (command === 'note_exists') {
      return (args as { path: string }).path in files
    }
    if (command === 'note_create') {
      const { path, contents } = args as { path: string; contents: string }
      if (path in files) {
        return { kind: 'collision' }
      }
      files[path] = contents
      return { kind: 'created', modifiedMs: 1 }
    }
    if (command === 'list_files') {
      return Object.entries(files).map(([path, contents]) => ({
        path,
        size: contents.length,
        modifiedMs: 1,
      }))
    }
    if (command === 'db_query') {
      return []
    }
    return null
  })
})

function mount(
  initialRoute: Route,
  probeRoute?: Route,
  options?: { strict?: boolean },
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = (
    <QueryClientProvider client={queryClient}>
      <RouterProvider initialRoute={initialRoute}>
        <MobileShell />
        {probeRoute ? <NavProbe to={probeRoute} /> : null}
      </RouterProvider>
    </QueryClientProvider>
  )
  // The app runs under StrictMode (main.tsx); opt in where a test guards
  // against impure updaters (dev double-invocation caught a double-pop once).
  return render(options?.strict ? <StrictMode>{tree}</StrictMode> : tree)
}

/** Stands in for a wiki-link tap: navigation arriving from inside a screen. */
function NavProbe({ to }: { to: Route }): ReactElement {
  const { navigate } = useRouter()
  return (
    <button type="button" onClick={() => navigate(to)}>
      probe-navigate
    </button>
  )
}

/** Every mounted stack layer, in DOM order (below → current → exiting). */
type BrowserView = Awaited<ReturnType<typeof render>>

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
 * Dispatch a pointer event the gesture hook can read.
 */
function firePointer(element: Element, type: string, init: Record<string, unknown>): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, init)
  element.dispatchEvent(event)
}

/** The calendar strip's per-day aria-label (CalendarStrip uses this form). */
function dayCellLabel(date: string): string {
  return format(parseIsoDate(date), 'EEEE, MMMM do')
}

/**
 * The strip header's settled month label — a month change rolls the old
 * label out, so the heading's whole textContent briefly holds both.
 */
function shownMonth(view: BrowserView): string | null {
  return (
    view
      .getByRole('heading', { level: 1 })
      .element()
      .querySelector('[data-slot="month-title"]')?.textContent ?? null
  )
}

/** A day in `date`'s week that isn't `date` itself (always present). */
function otherDayInWeek(date: string): string {
  const week = weekOf(date, 'monday')
  return week.find((day) => day !== date) ?? week[0]!
}

describe('MobileShell', () => {
  it('renders today as the daily spine with its note content', async () => {
    const today = todayIso()
    files[`daily/${today}.md`] = 'captured on the go'
    const view = await mount({ kind: 'today' })

    // The header is the month; the carousel mounts today's slide (±1
    // neighbours), each carrying its formatted date as the note's subject.
    expect(shownMonth(view)).toBe(monthLabel(monthOf(today)))
    await expect.element(view.getByText(formatDayLabel(today, 'mdy'))).toBeVisible()
    await waitFor(() => {
      const editors = view.getByTestId('fake-editor').elements()
      expect(editors.some((editor) => editor.textContent?.includes('captured on the go'))).toBe(true)
    })
  })

  it('selects a day from the calendar strip and jumps back to today', async () => {
    const user = userEvent
    const today = todayIso()
    const other = otherDayInWeek(today)
    const view = await mount({ kind: 'today' })

    expect(view.getByRole('button', { name: 'Today' }).query()).toBeNull()
    const todayButton = view.getByText('Today')
    expect(todayButton.element().classList.contains('opacity-0')).toBe(true)
    expect(todayButton.element().hasAttribute('inert')).toBe(true)

    await user.click(view.getByRole('button', { name: dayCellLabel(other) }))
    expect(
      view
        .getByRole('button', { name: dayCellLabel(other) })
        .element()
        .getAttribute('aria-current'),
    ).toBe('date')
    expect(
      view.getByRole('button', { name: 'Today' }).element().classList.contains('opacity-100'),
    ).toBe(true)
    expect(todayButton.element().hasAttribute('inert')).toBe(false)

    await user.click(view.getByRole('button', { name: 'Today' }))
    expect(view.getByRole('button', { name: 'Today' }).query()).toBeNull()
    expect(todayButton.element().classList.contains('opacity-0')).toBe(true)
    expect(todayButton.element().hasAttribute('inert')).toBe(true)
    expect(
      view
        .getByRole('button', { name: dayCellLabel(today) })
        .element()
        .getAttribute('aria-current'),
    ).toBe('date')
  })

  it('selects a day in another week straight from the pageable strip', async () => {
    const user = userEvent
    const today = todayIso()
    // Two weeks out: its cell lives on a different week slide of the strip,
    // which the strip renders (and Embla pages) rather than a single week.
    const nextFortnight = addDaysIso(today, 14)
    const view = await mount({ kind: 'today' })

    await user.click(view.getByRole('button', { name: dayCellLabel(nextFortnight) }))
    expect(
      view
        .getByRole('button', { name: dayCellLabel(nextFortnight) })
        .element()
        .getAttribute('aria-current'),
    ).toBe('date')
    expect(shownMonth(view)).toBe(monthLabel(monthOf(nextFortnight)))
    await expect.element(view.getByRole('button', { name: 'Today' })).toBeVisible()
  })

  it('jumps to a picked month from the month title’s picker sheet', async () => {
    const user = userEvent
    const today = todayIso()
    const view = await mount({ kind: 'today' })

    await user.click(view.getByRole('button', { name: 'Change month' }))
    await user.click(view.getByRole('button', { name: 'Next year' }))
    // January next year: always a different month, and (unlike a fixed
    // offset) always the same distance shape from today — date-agnostic.
    const pickedMonth = `${Number(monthOf(today).slice(0, 4)) + 1}-01`
    await user.click(view.getByRole('button', { name: monthLabel(pickedMonth) }))

    expect(view.getByTestId('drawer').query()).toBeNull()
    expect(shownMonth(view)).toBe(monthLabel(pickedMonth))
    const firstDay = `${pickedMonth}-01`
    expect(
      view
        .getByRole('button', { name: dayCellLabel(firstDay) })
        .element()
        .getAttribute('aria-current'),
    ).toBe('date')
    await expect.element(view.getByRole('button', { name: 'Today' })).toBeVisible()
  })

  it('keeps the selection when its own month is picked from the sheet', async () => {
    const user = userEvent
    const today = todayIso()
    const view = await mount({ kind: 'today' })

    await user.click(view.getByRole('button', { name: 'Change month' }))
    await user.click(view.getByRole('button', { name: monthLabel(monthOf(today)) }))

    expect(view.getByTestId('drawer').query()).toBeNull()
    expect(
      view
        .getByRole('button', { name: dayCellLabel(today) })
        .element()
        .getAttribute('aria-current'),
    ).toBe('date')
    expect(view.getByRole('button', { name: 'Today' }).query()).toBeNull()
  })

  it('fires haptics from the Daily header Today and Settings buttons', async () => {
    const user = userEvent
    const today = todayIso()
    const other = otherDayInWeek(today)
    const view = await mount({ kind: 'today' })

    await user.click(view.getByRole('button', { name: dayCellLabel(other) }))
    hapticImpactLight.mockClear()

    await user.click(view.getByRole('button', { name: 'Today' }))
    expect(hapticImpactLight).toHaveBeenCalledTimes(1)

    await user.click(view.getByRole('button', { name: 'Settings' }))
    expect(hapticImpactLight).toHaveBeenCalledTimes(2)
    await expect.element(view.getByRole('heading', { name: 'Settings' })).toBeVisible()
  })

  it('re-anchors the carousel when a date link lands outside its window', async () => {
    const user = userEvent
    // Beyond the ±366-day window — only reachable as a date-link navigation,
    // which forces the carousel to rebuild its window around the day.
    const farDay = addDaysIso(todayIso(), 400)
    files[`daily/${farDay}.md`] = 'far future plans'
    const view = await mount({ kind: 'today' }, { kind: 'daily', date: farDay })

    await user.click(view.getByRole('button', { name: 'probe-navigate' }))
    expect(shownMonth(view)).toBe(monthLabel(monthOf(farDay)))
    await waitFor(() => {
      const editors = view.getByTestId('fake-editor').elements()
      expect(editors.some((editor) => editor.textContent?.includes('far future plans'))).toBe(true)
    })
  })

  it('opens a note from in-screen navigation and pops back through history', async () => {
    const user = userEvent
    files['notes/meeting-notes.md'] = 'agenda'
    const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })

    await user.click(view.getByRole('button', { name: 'probe-navigate' }))
    expect(view.getByRole('heading').element().textContent).toBe('Edit note')

    await user.click(view.getByRole('button', { name: 'Back' }))
    expect(shownMonth(view)).toBe(monthLabel(monthOf(todayIso())))
  })

  it('never focuses the destination editor on navigation (keyboard stays down)', async () => {
    const user = userEvent
    files['notes/source.md'] = 'see [[Target Note]]'
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
    const today = todayIso()
    const other = otherDayInWeek(today)
    const view = await mount({ kind: 'today' })

    await user.click(view.getByRole('button', { name: dayCellLabel(other) }))
    expect(
      view
        .getByRole('button', { name: dayCellLabel(other) })
        .element()
        .getAttribute('aria-current'),
    ).toBe('date')

    await user.click(view.getByRole('button', { name: 'All' }))
    await expect.element(view.getByRole('searchbox', { name: 'Search notes' })).toBeVisible()
    await expect.element(view.getByText('No notes yet')).toHaveTextContent('No notes yet')

    await user.click(view.getByRole('button', { name: 'Daily' }))
    expect(
      view
        .getByRole('button', { name: dayCellLabel(other) })
        .element()
        .getAttribute('aria-current'),
    ).toBe('date')
  })

  it('double-tapping Daily opens today and focuses the daily editor at its end', async () => {
    const user = userEvent
    const today = todayIso()
    const other = otherDayInWeek(today)
    const view = await mount({ kind: 'today' })

    await user.click(view.getByRole('button', { name: dayCellLabel(other) }))
    await user.click(view.getByRole('button', { name: 'All' }))
    await expect.element(view.getByRole('searchbox', { name: 'Search notes' })).toBeVisible()

    let fakeNow = 1_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)

    fireEvent.click(view.getByRole('button', { name: 'Daily' }))
    expect(
      view
        .getByRole('button', { name: dayCellLabel(other) })
        .element()
        .getAttribute('aria-current'),
    ).toBe('date')

    fakeNow = 1_100
    fireEvent.click(view.getByRole('button', { name: 'Daily' }))
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
    const today = todayIso()
    files[`daily/${today}.md`] = 'first thought'
    const view = await mount({ kind: 'today' })
    await waitFor(() => {
      const editors = view.getByTestId('fake-editor').elements()
      expect(editors.some((editor) => editor.textContent?.includes('first thought'))).toBe(true)
    })

    let fakeNow = 1_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)
    fireEvent.click(view.getByRole('button', { name: 'Daily' }))
    fakeNow = 1_100
    fireEvent.click(view.getByRole('button', { name: 'Daily' }))
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
    const today = todayIso()
    const other = otherDayInWeek(today)
    const view = await mount({ kind: 'daily', date: other })

    await user.click(view.getByRole('button', { name: 'Daily' }))
    expect(
      view
        .getByRole('button', { name: dayCellLabel(other) })
        .element()
        .getAttribute('aria-current'),
    ).toBe('date')
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
    await expect.element(view.getByText('No tasks to show')).toHaveTextContent('No tasks to show')
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
    await waitFor(() => expect(document.activeElement).toBe(box))
    expect(box.selectionStart).toBe(0)
    expect(box.selectionEnd).toBe(box.value.length)
  })

  it('hides the tab bar while the software keyboard is up (V1: the keyboard covered it)', async () => {
    const view = await mount({ kind: 'today' })
    await expect.element(view.getByRole('navigation', { name: 'Sections' })).toBeVisible()

    await act(() => publishKeyboardHeight(316))
    expect(view.getByRole('navigation', { name: 'Sections' }).query()).toBeNull()

    await act(() => publishKeyboardHeight(0))
    await expect.element(view.getByRole('navigation', { name: 'Sections' })).toBeVisible()
  })

  it('gives the tab bar slot to the formatting toolbar only while an editor is focused', async () => {
    const view = await mount({ kind: 'today' })
    const owner = Symbol('shell-test')

    // Keyboard up with no focused editor (the All-tab search field): neither
    // the tab bar nor a dead-button toolbar.
    await act(() => publishKeyboardHeight(316))
    expect(view.getByRole('toolbar', { name: 'Formatting' }).query()).toBeNull()

    await act(() =>
      publishFormattingToolbar(owner, {
        capabilities: { canIndent: true, canDedent: false, canMoveUp: true, canMoveDown: true },
        commands: {
          toggleBulletList: vi.fn(),
          cycleCheckableList: vi.fn(),
          indent: vi.fn(),
          dedent: vi.fn(),
          moveUp: vi.fn(),
          moveDown: vi.fn(),
          insertTrigger: vi.fn(),
          dismissKeyboard: vi.fn(),
          scrollCaretIntoView: vi.fn(),
        },
      }),
    )
    await expect.element(view.getByRole('toolbar', { name: 'Formatting' })).toBeVisible()
    expect(view.getByRole('navigation', { name: 'Sections' }).query()).toBeNull()

    await act(() => {
      clearFormattingToolbar(owner)
      publishKeyboardHeight(0)
    })
    expect(view.getByRole('toolbar', { name: 'Formatting' }).query()).toBeNull()
    await expect.element(view.getByRole('navigation', { name: 'Sections' })).toBeVisible()
  })

  it('renders a search entry as the All tab with the query seeded', async () => {
    const user = userEvent
    const view = await mount({ kind: 'search', query: 'meeting' })

    const box = view.getByRole('searchbox', { name: 'Search notes' })
    await waitFor(() => {
      expect((box.element() as HTMLInputElement).value).toBe('meeting')
    })
    expect(
      view.getByRole('button', { name: 'All' }).element().getAttribute('aria-current'),
    ).toBe('page')

    await user.click(view.getByRole('button', { name: 'Clear search' }))

    expect((box.element() as HTMLInputElement).value).toBe('')
    expect(view.getByRole('button', { name: 'Clear search' }).query()).toBeNull()
  })

  it('back from a cold note entry lands on today', async () => {
    const user = userEvent
    files['notes/meeting-notes.md'] = 'agenda'
    const view = await mount({ kind: 'note', path: 'notes/meeting-notes.md' })

    expect(view.getByRole('heading').element().textContent).toBe('Edit note')
    await waitFor(() => {
      expect(
        page.elementLocator(visibleLayer(view)).getByTestId('fake-editor').element().textContent,
      ).toContain('agenda')
    })

    await user.click(view.getByRole('button', { name: 'Back' }))
    expect(shownMonth(view)).toBe(monthLabel(monthOf(todayIso())))
  })
})

/**
 * The navigation stack (V1 parity): a pushed note slides in as a card over
 * its origin (which stays mounted, hidden, and inert beneath it), popping
 * slides it out, tab switches stay instant, and an edge back-swipe drags the
 * card with the finger — popping past the threshold, snapping back short of
 * it. Tests drive the `animationend` / `transitionend` completions by hand.
 */
describe('MobileStack transitions & back-swipe', () => {
  // The test browser pins `prefers-reduced-motion: reduce`, which turns the
  // stack's animations off. These tests are about the animated path, so they
  // report the animating preference; the reduced-motion test below stubs the
  // other answer for itself.
  const animatingMatchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof matchMedia
  let realMatchMedia: typeof matchMedia

  beforeEach(() => {
    realMatchMedia = globalThis.matchMedia
    globalThis.matchMedia = animatingMatchMedia
  })

  afterEach(() => {
    globalThis.matchMedia = realMatchMedia
  })

  /** Navigate to the probe note and complete the push animation. */
  async function pushProbeNote(view: BrowserView): Promise<void> {
    const user = userEvent
    await user.click(view.getByRole('button', { name: 'probe-navigate' }))
    fireEvent.animationEnd(stackLayers(view).at(-1)!)
  }

  it('pushes a note as a sliding card over its origin, which stays mounted but inert', async () => {
    const user = userEvent
    files['notes/meeting-notes.md'] = 'agenda'
    const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })

    await user.click(view.getByRole('button', { name: 'probe-navigate' }))
    const layers = stackLayers(view)
    expect(layers).toHaveLength(2)
    const [origin, entering] = layers
    expect(entering!.className).toContain('mobile-stack-slide-in')
    expect(origin!.getAttribute('aria-hidden')).toBe('true')
    expect(
      page
        .elementLocator(origin!)
        .locate('h1')
        .element()
        .querySelector('[data-slot="month-title"]')?.textContent,
    ).toBe(monthLabel(monthOf(todayIso())))
    expect(view.container.querySelector('.mobile-stack-scrim')).toBeTruthy()

    fireEvent.animationEnd(entering!)
    // The animation class clears; the origin stays mounted for the back-swipe.
    expect(entering!.className).not.toContain('mobile-stack-slide-in')
    expect(stackLayers(view)).toHaveLength(2)
  })

  it('pops the note with a slide-out and unmounts it when the animation ends', async () => {
    const user = userEvent
    files['notes/meeting-notes.md'] = 'agenda'
    const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })
    await pushProbeNote(view)

    await user.click(view.getByRole('button', { name: 'Back' }))
    // Daily is current again immediately; the note lingers only to animate out.
    expect(shownMonth(view)).toBe(monthLabel(monthOf(todayIso())))
    const exiting = stackLayers(view).at(-1)!
    expect(exiting.className).toContain('mobile-stack-slide-out')
    expect(exiting.getAttribute('aria-hidden')).toBe('true')

    fireEvent.animationEnd(exiting)
    expect(stackLayers(view)).toHaveLength(1)
  })

  it('keeps tab switches instant: one layer, no slide (V1 cross-fade at most)', async () => {
    const user = userEvent
    const view = await mount({ kind: 'today' })
    expect(stackLayers(view)).toHaveLength(1)

    await user.click(view.getByRole('button', { name: 'All' }))
    const layers = stackLayers(view)
    expect(layers).toHaveLength(1)
    expect(layers[0]!.className).not.toContain('mobile-stack-slide-in')
    expect(view.container.querySelector('.mobile-stack-scrim')).toBeNull()
  })

  it('follows history direction within a note chain: wiki-link pushes, back pops', async () => {
    const user = userEvent
    files['notes/source.md'] = 'see [[Target Note]]'
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
    fireEvent.animationEnd(stackLayers(view).at(-1)!)

    await user.click(view.getByRole('button', { name: 'Back' }))
    // Popping reveals the still-mounted source, re-seats today beneath it,
    // and slides the destination out — three layers, briefly.
    const layers = stackLayers(view)
    expect(layers).toHaveLength(3)
    expect(layers.at(-1)!.className).toContain('mobile-stack-slide-out')
    expect(
      page.elementLocator(visibleLayer(view)).getByRole('heading').element().textContent,
    ).toBe('Edit note')
    fireEvent.animationEnd(layers.at(-1)!)
    expect(stackLayers(view)).toHaveLength(2)
  })

  it('cuts instantly under prefers-reduced-motion', async () => {
    const originalMatchMedia = globalThis.matchMedia
    globalThis.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof matchMedia
    try {
      const user = userEvent
      files['notes/meeting-notes.md'] = 'agenda'
      const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })

      await user.click(view.getByRole('button', { name: 'probe-navigate' }))
      expect(stackLayers(view).at(-1)!.className).not.toContain('mobile-stack-slide-in')

      await user.click(view.getByRole('button', { name: 'Back' }))
      // No exit animation: the note is gone the moment the route changes.
      expect(stackLayers(view)).toHaveLength(1)
    } finally {
      globalThis.matchMedia = originalMatchMedia
    }
  })

  it('pops the note when an edge swipe crosses the release threshold', async () => {
    files['notes/meeting-notes.md'] = 'agenda'
    const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })
    await pushProbeNote(view)

    const stack = view.container.querySelector('.mobile-stack')!
    const card = stackLayers(view).at(-1)!
    firePointer(stack, 'pointerdown', {
      pointerId: 1,
      isPrimary: true,
      pointerType: 'touch',
      clientX: 10,
      clientY: 300,
    })
    firePointer(stack, 'pointermove', { pointerId: 1, clientX: 40, clientY: 304 })
    // The card tracks the finger in the 375px mobile viewport.
    // The browser normalizes the written value's bare zeros to `0px`.
    expect(card.style.transform).toBe('translate3d(30px, 0px, 0px)')

    firePointer(stack, 'pointermove', { pointerId: 1, clientX: 600, clientY: 310 })
    firePointer(stack, 'pointerup', { pointerId: 1, clientX: 600, clientY: 310 })
    // Released past the threshold: the card settles offscreen...
    expect(card.style.transform).toBe('translate3d(100%, 0px, 0px)')

    // ...and only then commits the pop.
    fireEvent.transitionEnd(card)
    expect(shownMonth(view)).toBe(monthLabel(monthOf(todayIso())))
    expect(stackLayers(view)).toHaveLength(1)
  })

  it('commits a gesture pop exactly once (StrictMode + same-frame double transitionend)', async () => {
    // Three-deep history (today → All → note): a double-committed pop would
    // sail past All and land on today. Two real-world double-fire vectors:
    // StrictMode's dev double-invocation (which caught an impure updater
    // once), and the card's transform + the scrim's opacity settling in the
    // same frame, so `transitionend` arrives twice before React re-renders.
    const user = userEvent
    files['notes/meeting-notes.md'] = 'agenda'
    const view = await mount(
      { kind: 'today' },
      { kind: 'note', path: 'notes/meeting-notes.md' },
      {
        strict: true,
      },
    )
    await user.click(view.getByRole('button', { name: 'All' }))
    await pushProbeNote(view)

    const stack = view.container.querySelector('.mobile-stack')!
    const card = stackLayers(view).at(-1)!
    firePointer(stack, 'pointerdown', {
      pointerId: 1,
      isPrimary: true,
      pointerType: 'touch',
      clientX: 10,
      clientY: 300,
    })
    firePointer(stack, 'pointermove', { pointerId: 1, clientX: 40, clientY: 304 })
    firePointer(stack, 'pointermove', { pointerId: 1, clientX: 600, clientY: 310 })
    firePointer(stack, 'pointerup', { pointerId: 1, clientX: 600, clientY: 310 })

    await act(() => {
      card.dispatchEvent(new Event('transitionend', { bubbles: true }))
      card.dispatchEvent(new Event('transitionend', { bubbles: true }))
    })
    await expect.element(view.getByRole('searchbox', { name: 'Search notes' })).toBeVisible()
  })

  it('snaps back when the swipe releases short of the threshold', async () => {
    files['notes/meeting-notes.md'] = 'agenda'
    const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })
    await pushProbeNote(view)

    // A slow machine can stretch the gap between synthetic moves past the
    // hook's velocity-sampling window, turning this short drag into a
    // "flick" that pops. Pin the clock so the drag reads as slow and the
    // release decision is purely distance-based.
    let clock = 1000
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 5))
    try {
      const stack = view.container.querySelector('.mobile-stack')!
      const card = stackLayers(view).at(-1)!
      firePointer(stack, 'pointerdown', {
        pointerId: 1,
        isPrimary: true,
        pointerType: 'touch',
        clientX: 10,
        clientY: 300,
      })
      firePointer(stack, 'pointermove', { pointerId: 1, clientX: 40, clientY: 304 })
      firePointer(stack, 'pointermove', { pointerId: 1, clientX: 120, clientY: 306 })
      firePointer(stack, 'pointerup', { pointerId: 1, clientX: 120, clientY: 306 })
      expect(card.style.transform).toBe('translate3d(0px, 0px, 0px)')

      fireEvent.transitionEnd(card)
      expect(view.getByRole('heading').element().textContent).toBe('Edit note')
      expect(stackLayers(view)).toHaveLength(2)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('ignores mid-screen touches, mouse pointers, and vertical scrolls', async () => {
    files['notes/meeting-notes.md'] = 'agenda'
    const view = await mount({ kind: 'today' }, { kind: 'note', path: 'notes/meeting-notes.md' })
    await pushProbeNote(view)

    const stack = view.container.querySelector('.mobile-stack')!
    const card = stackLayers(view).at(-1)!

    // Not from the edge.
    firePointer(stack, 'pointerdown', {
      pointerId: 1,
      isPrimary: true,
      pointerType: 'touch',
      clientX: 200,
      clientY: 300,
    })
    firePointer(stack, 'pointermove', { pointerId: 1, clientX: 260, clientY: 300 })
    expect(card.style.transform).toBe('')
    firePointer(stack, 'pointerup', { pointerId: 1, clientX: 260, clientY: 300 })

    // Not a touch.
    firePointer(stack, 'pointerdown', {
      pointerId: 2,
      isPrimary: true,
      pointerType: 'mouse',
      clientX: 10,
      clientY: 300,
    })
    firePointer(stack, 'pointermove', { pointerId: 2, clientX: 80, clientY: 300 })
    expect(card.style.transform).toBe('')
    firePointer(stack, 'pointerup', { pointerId: 2, clientX: 80, clientY: 300 })

    // Vertical intent from the edge: the scroll wins and the gesture disarms.
    firePointer(stack, 'pointerdown', {
      pointerId: 3,
      isPrimary: true,
      pointerType: 'touch',
      clientX: 10,
      clientY: 300,
    })
    firePointer(stack, 'pointermove', { pointerId: 3, clientX: 14, clientY: 360 })
    firePointer(stack, 'pointermove', { pointerId: 3, clientX: 80, clientY: 360 })
    expect(card.style.transform).toBe('')
  })
})
