import { act, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import { todayIso } from '@/lib/dates'
import { createDayWindow, neighborDate } from '@/lib/day-window'
import { RouterProvider, useRouter, type NavigateOptions } from '@/routing/router'
import type { Route } from '@/routing/route'
import { fireEvent } from '@/test-utils/fire-event'
import '@/test-utils/locator'
import { DailyStream } from './daily-stream'

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

beforeEach(() => {
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

async function renderStream() {
  let navigate: Navigate = () => {
    throw new Error('navigate not ready')
  }
  const view = await render(
    <div style={{ height: 800 }}>
      <RouterProvider initialRoute={{ kind: 'today' }}>
        <DailyStream target={{ kind: 'today' }} />
        <NavigateProbe
          onReady={(run) => {
            navigate = run
          }}
        />
      </RouterProvider>
    </div>,
  )
  const paneFor = (date: string) =>
    page.locate(`[data-testid="pane-probe"][data-date="${date}"]`)
  return {
    view,
    navigate: (route: Route, options?: NavigateOptions) => navigate(route, options),
    anchored: (date: string) => expect.element(paneFor(date)).toBeInTheDocument(),
    paneFor,
  }
}

describe('DailyStream arrival focus', () => {
  it('a capture arrival (focusEditor) focuses today with the caret at the end', async () => {
    const today = todayIso()
    const { view, navigate, anchored, paneFor } = await renderStream()

    await act(() => navigate({ kind: 'today' }, { focusEditor: true }))
    await anchored(today)

    const pane = paneFor(today)
    await expect.element(pane).toHaveAttribute('data-autofocus', 'true')
    await expect.element(pane).toHaveAttribute('data-selection', 'end')
    await view.unmount()
  })

  it('clicking a day’s date heading focuses that day’s note at its start', async () => {
    const today = todayIso()
    const yesterday = neighborDate(createDayWindow(today), today, -1)
    expect(yesterday).not.toBeNull()
    const { view, anchored, paneFor } = await renderStream()
    await anchored(today)
    await expect.element(paneFor(yesterday!)).toBeInTheDocument()
    focusLog.calls.length = 0

    const heading = paneFor(yesterday!).element().closest('section')?.querySelector('h2')
    expect(heading).not.toBeNull()
    fireEvent.click(heading!)

    expect(focusLog.calls).toEqual([
      `focus:${yesterday}`,
      `setSelection:${yesterday}:start`,
    ])
    await view.unmount()
  })

  it('a heading click focuses even while a selection stands elsewhere', async () => {
    // The heading is unselectable chrome (`user-select: none`), so mousedown
    // on it leaves an editor selection uncollapsed — the click must still
    // focus rather than treating the stale selection as a copy gesture.
    const today = todayIso()
    const { view, anchored, paneFor } = await renderStream()
    await anchored(today)
    focusLog.calls.length = 0

    const heading = paneFor(today).element().closest('section')?.querySelector('h2')
    expect(heading).not.toBeNull()
    const range = document.createRange()
    range.selectNodeContents(heading!)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent.click(heading!)

    expect(focusLog.calls).toEqual([`focus:${today}`, `setSelection:${today}:start`])
    selection?.removeAllRanges()
    await view.unmount()
  })

  it('an ordinary arrival keeps the default start-of-note focus', async () => {
    const today = todayIso()
    const { view, navigate, anchored, paneFor } = await renderStream()

    // A capture arrival first, so the follow-up proves the append intent is
    // one-shot rather than sticky.
    await act(() => navigate({ kind: 'today' }, { focusEditor: true }))
    await act(() => navigate({ kind: 'today' }))
    await anchored(today)

    const pane = paneFor(today)
    await expect.element(pane).toHaveAttribute('data-autofocus', 'true')
    await expect.element(pane).toHaveAttribute('data-selection', 'start')
    await view.unmount()
  })
})
