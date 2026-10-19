import { page } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import {
  createRef,
  useEffect,
  useLayoutEffect,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react'
import { act } from '@/test-utils/act.ts'
import { createSystemClock, type ClockService } from '@reflect/core'
import { createTestCoreServices, createTestClockService } from '@reflect/core/testing'
import { FocusedDailyProvider, useFocusedDailyDate } from '@/providers/focused-daily-provider.tsx'
import { useRouter } from '@/routing/router.tsx'
import { formatDayLabel, todayIso } from '@/lib/dates.ts'
import { createDayWindow, dateAtIndex, indexOfDate } from '@/lib/day-window.ts'
import { fireEvent } from '@/test-utils/fire-event.ts'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { DailyStream, ESTIMATED_DAY_HEIGHT } from './daily-stream.tsx'

/**
 * The stream's first-paint anchor: virtua must put the scroll element at the
 * target day (or a back/forward entry's saved offset) before paint, so opening
 * the app never shows the top of the five-year window and then lurches down to
 * today. virtua applies an imperative scroll by assigning `scrollTop` in a
 * microtask. These tests assert the resulting real browser layout and also
 * cover the loading-placeholder contract (reserved editor space, delayed hint).
 */

vi.mock('@/editor/note-editor.tsx', () => ({
  NoteEditor: () => <div data-testid="fake-editor" />,
}))
/**
 * A test clock at 23:59 on 2026-06-27, for the app of {@link renderStream}.
 */
function clockBeforeMidnight(): ReturnType<typeof createTestClockService> {
  return createTestClockService({ now: new Date(2026, 5, 27, 23, 59, 0).getTime() })
}

function Stream({ children }: { children: ReactNode }): ReactElement {
  return <div style={{ height: 800 }}>{children}</div>
}

/**
 * Render `children` in a stream-sized box; the app runs on `clock` (the system clock by default).
 */
async function renderStream(children: ReactNode, clock: ClockService = createSystemClock()) {
  const app = createTestCoreServices({ database: createWasmTestDatabaseService(), clock })
  // Reads never resolve: every day stays a loading placeholder.
  vi.spyOn(app.noteFile, 'read').mockReturnValue(new Promise(() => {}))
  return await renderInApp(<Stream>{children}</Stream>, {
    app,
    graph: { root: '/g', name: 'g', generation: 1 },
    settings: { dateFormat: 'mdy', editorMarkdownSyntax: 'hide', editorSpellCheck: true },
    route: { kind: 'today' },
  })
}

/**
 * Records `offset` on the current history entry, as a view's scroll would.
 */
function SaveScrollProbe({ offset }: { offset: number }): ReactElement | null {
  const { saveScrollState } = useRouter()
  useEffect(() => {
    saveScrollState(offset)
  }, [saveScrollState, offset])
  return null
}

function NavigateTodayProbe({ onReady }: { onReady: (navigateToday: () => void) => void }): null {
  const { navigate } = useRouter()
  useEffect(() => {
    onReady(() => navigate({ kind: 'today' }))
  }, [navigate, onReady])
  return null
}

describe('DailyStream', () => {
  it('anchors its first scroll to today, with no top-of-window flicker', async () => {
    const today = todayIso()
    const view = await renderStream(<DailyStream target={{ kind: 'today' }} />)

    const stream = page.getByTestId('daily-stream')
    await vi.waitFor(() => expect(stream.element().scrollTop).toBeGreaterThan(0))
    await expect.element(page.getByText(formatDayLabel(today, 'mdy'))).toBeVisible()
    await view.unmount()
  })

  it('re-anchors a today arrival to the stream-local day after midnight', async () => {
    const clock = clockBeforeMidnight()
    let navigateToday: () => void = () => {
      throw new Error('navigate not ready')
    }
    const view = await renderStream(
      <>
        <DailyStream target={{ kind: 'today' }} />
        <NavigateTodayProbe
          onReady={(run) => {
            navigateToday = run
          }}
        />
      </>,
      clock,
    )

    const dayWindow = createDayWindow('2026-06-27')
    await act(async () => {
      await clock.advance(2 * 60 * 1000)
    })
    await act(() => {
      navigateToday()
    })

    const expected = indexOfDate(dayWindow, '2026-06-28') * ESTIMATED_DAY_HEIGHT
    await vi.waitFor(() =>
      expect(page.getByTestId('daily-stream').element().scrollTop).toBeGreaterThan(
        expected - ESTIMATED_DAY_HEIGHT,
      ),
    )
    await expect.element(page.getByText(formatDayLabel('2026-06-28', 'mdy'))).toBeVisible()
    await view.unmount()
  })

  it('anchors a today arrival to the real day after a slept-through midnight', async () => {
    const clock = clockBeforeMidnight()
    let navigateToday: () => void = () => {
      throw new Error('navigate not ready')
    }
    const view = await renderStream(
      <>
        <DailyStream target={{ kind: 'today' }} />
        <NavigateTodayProbe
          onReady={(run) => {
            navigateToday = run
          }}
        />
      </>,
      clock,
    )

    // Simulated sleep: the wall clock jumps but no timer fires (DOM timers
    // run on a monotonic clock that pauses while the machine sleeps).
    await act(() => {
      clock.setNow(new Date(2026, 5, 28, 9, 0, 0).getTime())
    })
    await act(() => {
      navigateToday()
    })

    const dayWindow = createDayWindow('2026-06-27')
    const expected = indexOfDate(dayWindow, '2026-06-28') * ESTIMATED_DAY_HEIGHT
    await vi.waitFor(() =>
      expect(page.getByTestId('daily-stream').element().scrollTop).toBeGreaterThan(
        expected - ESTIMATED_DAY_HEIGHT,
      ),
    )
    await expect.element(page.getByText(formatDayLabel('2026-06-28', 'mdy'))).toBeVisible()
    await view.unmount()
  })

  it('mounts straight at a restored entry’s saved offset, not the anchor', async () => {
    const view = await renderStream(<SaveScrollProbe offset={4321} />)
    await view.rerender(
      <Stream>
        <SaveScrollProbe offset={4321} />
        <DailyStream target={{ kind: 'today' }} />
      </Stream>,
    )

    await vi.waitFor(() =>
      expect(page.getByTestId('daily-stream').element().scrollTop).toBeCloseTo(4321, -1),
    )
    await view.unmount()
  })

  it('reports the focused day so the sidebar can follow it within the stream', async () => {
    const today = todayIso()
    const dayWindow = createDayWindow(today)
    const focusedRef: RefObject<string | null> = createRef()
    function FocusProbe(): null {
      const focused = useFocusedDailyDate()

      useLayoutEffect(() => {
        focusedRef.current = focused
        return () => {
          focusedRef.current = null
        }
      }, [focused])

      return null
    }
    const view = await renderStream(
      <>
        <FocusedDailyProvider>
          <DailyStream target={{ kind: 'date', date: today }} />
          <FocusProbe />
        </FocusedDailyProvider>
      </>,
    )

    // Focus enters a stream row (the route is unchanged): the sidebar's day
    // must move to that row's date, not stay on the routed day.
    const row = await vi.waitFor(() => {
      const el = view.container.querySelector('[data-index]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    const date = dateAtIndex(dayWindow, Number(row.getAttribute('data-index')))
    await act(() => {
      fireEvent.focusIn(row)
    })

    expect(focusedRef.current).toBe(date)
    await view.unmount()
  })

  it('reserves the editor’s space on loading placeholders, with the hint delayed', async () => {
    const view = await renderStream(<DailyStream target={{ kind: 'today' }} />)

    await vi.waitFor(() =>
      expect(document.querySelectorAll('.reflect-note-loading').length).toBeGreaterThan(0),
    )
    const placeholders = document.querySelectorAll('.reflect-note-loading')
    expect(placeholders.length).toBeGreaterThan(0)
    for (const placeholder of placeholders) {
      expect(placeholder.className).toContain('reflect-note-loading')
      expect(placeholder.className).toMatch(/min-h-/)
    }
    await view.unmount()
  })
})
