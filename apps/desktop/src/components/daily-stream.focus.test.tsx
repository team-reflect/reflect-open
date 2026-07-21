import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import { todayIso } from '@/lib/dates'
import { createDayWindow, neighborDate } from '@/lib/day-window'
import { RouterProvider, useRouter, type NavigateOptions } from '@/routing/router'
import type { Route } from '@/routing/route'
import { installVirtuaTestEnv } from '@/test-utils/virtua-jsdom'
import { DailyStream, ESTIMATED_DAY_HEIGHT } from './daily-stream'

/**
 * The stream's arrival-focus contract: every fresh arrival autofocuses the
 * target day, and only a capture arrival — `navigate(..., { focusEditor:
 * true })`, i.e. ⌘D or the sidebar's Daily notes row — asks for the caret at
 * the *end* of the day's content (append semantics, mobile double-tap
 * parity). NotePane is replaced by a probe that just reports the focus props
 * it was handed; the real mount-and-focus mechanics live in NotePane.
 *
 * Each test navigates *before* the target row exists and only then lets
 * virtua render it, mirroring the real sequence (the arrival's imperative
 * scroll is what brings the day's row into range, and the row reads its
 * focus assignment as it mounts).
 */

/**
 * Focus/selection calls the probe's registered handles receive, as
 * `"<method>:<date>[:<arg>]"` — hoisted so the NotePane mock factory can
 * reach it.
 */
const focusLog = vi.hoisted(() => ({ calls: [] as string[] }))

vi.mock('@/components/note-pane', () => ({
  NotePane: ({
    dailyDate,
    autoFocus = false,
    autoFocusSelection = 'start',
    registerHandle,
  }: {
    dailyDate?: string
    autoFocus?: boolean
    autoFocusSelection?: 'start' | 'end'
    registerHandle?: (
      date: string,
      handle: import('@/editor/note-editor').NoteEditorHandle | null,
    ) => void
  }) => {
    // Register a recording handle like the real pane's mounted editor would,
    // so the stream's imperative focus paths (heading click, cross-day arrow
    // navigation) are observable.
    useEffect(() => {
      if (dailyDate === undefined || registerHandle === undefined) {
        return
      }
      registerHandle(dailyDate, {
        getMarkdown: () => '',
        setMarkdown: () => {},
        insertMarkdown: () => {},
        focus: () => {
          focusLog.calls.push(`focus:${dailyDate}`)
        },
        setSelection: (position: 'start' | 'end') => {
          focusLog.calls.push(`setSelection:${dailyDate}:${position}`)
        },
        getSelectedText: () => '',
        openSelectionMenu: () => {},
        startPendingReplacement: () => false,
        appendPendingReplacementText: () => {},
        acceptPendingReplacement: () => {},
        discardPendingReplacement: () => {},
      })
      return () => registerHandle(dailyDate, null)
    }, [dailyDate, registerHandle])
    return (
      <div
        data-testid="pane-probe"
        data-date={dailyDate}
        data-autofocus={String(autoFocus)}
        data-selection={autoFocusSelection}
      />
    )
  },
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: { dateFormat: 'mdy' },
    updateSettings: async () => {},
    updateSettingsWith: () => {},
  }),
}))

installVirtuaTestEnv((element) =>
  element.dataset['testid'] === 'daily-stream' ? 800 : ESTIMATED_DAY_HEIGHT,
)
Element.prototype.scrollTo ??= () => {}

// virtua anchors by assigning `scrollTop`, which jsdom ignores by default —
// retain the value so scroll events report the anchored offset back.
let scrollTop = 0
Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
  configurable: true,
  get() {
    return scrollTop
  },
  set(value: number) {
    scrollTop = Number(value)
  },
})

beforeEach(() => {
  scrollTop = 0
  focusLog.calls.length = 0
})

type Navigate = (route: Route, options?: NavigateOptions) => void

function NavigateProbe({ onReady }: { onReady: (navigate: Navigate) => void }): null {
  const { navigate } = useRouter()
  useEffect(() => {
    onReady(navigate)
  }, [navigate, onReady])
  return null
}

function renderStream() {
  let navigate: Navigate = () => {
    throw new Error('navigate not ready')
  }
  const view = render(
    <RouterProvider initialRoute={{ kind: 'today' }}>
      <DailyStream target={{ kind: 'today' }} />
      <NavigateProbe
        onReady={(run) => {
          navigate = run
        }}
      />
    </RouterProvider>,
  )
  const paneFor = (date: string) =>
    view.container.querySelector(`[data-testid="pane-probe"][data-date="${date}"]`)
  return {
    view,
    navigate: (route: Route, options?: NavigateOptions) => navigate(route, options),
    // jsdom fires no scroll events, so virtua never learns about the offset
    // the arrival assigned — nudge it until the target day's row renders.
    anchored: (date: string) =>
      waitFor(() => {
        const stream = view.container.querySelector('[data-testid="daily-stream"]')
        expect(stream).not.toBeNull()
        fireEvent.scroll(stream!)
        expect(paneFor(date)).not.toBeNull()
      }),
    paneFor,
  }
}

describe('DailyStream arrival focus', () => {
  it('a capture arrival (focusEditor) focuses today with the caret at the end', async () => {
    const today = todayIso()
    const { view, navigate, anchored, paneFor } = renderStream()

    act(() => navigate({ kind: 'today' }, { focusEditor: true }))
    await anchored(today)

    const pane = paneFor(today)
    expect(pane?.getAttribute('data-autofocus')).toBe('true')
    expect(pane?.getAttribute('data-selection')).toBe('end')
    view.unmount()
  })

  it('clicking a day’s date heading focuses that day’s note at its start', async () => {
    const today = todayIso()
    const yesterday = neighborDate(createDayWindow(today), today, -1)
    expect(yesterday).not.toBeNull()
    const { view, anchored, paneFor } = renderStream()
    await anchored(today)
    await waitFor(() => expect(paneFor(yesterday!)).not.toBeNull())
    focusLog.calls.length = 0

    const heading = paneFor(yesterday!)?.closest('section')?.querySelector('h2')
    expect(heading).not.toBeNull()
    fireEvent.click(heading!)

    expect(focusLog.calls).toEqual([
      `focus:${yesterday}`,
      `setSelection:${yesterday}:start`,
    ])
    view.unmount()
  })

  it('a heading click focuses even while a selection stands elsewhere', async () => {
    // The heading is unselectable chrome (`user-select: none`), so mousedown
    // on it leaves an editor selection uncollapsed — the click must still
    // focus rather than treating the stale selection as a copy gesture.
    const today = todayIso()
    const { view, anchored, paneFor } = renderStream()
    await anchored(today)
    focusLog.calls.length = 0

    const heading = paneFor(today)?.closest('section')?.querySelector('h2')
    expect(heading).not.toBeNull()
    const range = document.createRange()
    range.selectNodeContents(heading!)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent.click(heading!)

    expect(focusLog.calls).toEqual([`focus:${today}`, `setSelection:${today}:start`])
    selection?.removeAllRanges()
    view.unmount()
  })

  it('an ordinary arrival keeps the default start-of-note focus', async () => {
    const today = todayIso()
    const { view, navigate, anchored, paneFor } = renderStream()

    // A capture arrival first, so the follow-up proves the append intent is
    // one-shot rather than sticky.
    act(() => navigate({ kind: 'today' }, { focusEditor: true }))
    act(() => navigate({ kind: 'today' }))
    await anchored(today)

    const pane = paneFor(today)
    expect(pane?.getAttribute('data-autofocus')).toBe('true')
    expect(pane?.getAttribute('data-selection')).toBe('start')
    view.unmount()
  })
})
