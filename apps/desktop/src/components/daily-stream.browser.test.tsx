import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { setBridge } from '@reflect/core'
import {
  FocusedDailyProvider,
  useFocusedDailyDate,
} from '@/providers/focused-daily-provider'
import { RouterProvider, useRouter } from '@/routing/router'
import { todayIso } from '@/lib/dates'
import { createDayWindow, dateAtIndex, indexOfDate } from '@/lib/day-window'
import { act } from '@/test-utils/act'
import { DailyStream, ESTIMATED_DAY_HEIGHT } from './daily-stream'

/**
 * The stream's first-paint anchor: virtua must put the scroll element at the
 * target day (or a back/forward entry's saved offset) before paint, so opening
 * the app never shows the top of the five-year window and then lurches down to
 * today. virtua applies an imperative scroll by assigning `scrollTop` in a
 * microtask, so these tests flush that and pin the *first* offset it writes. The
 * note read never resolves, so they also cover the loading-placeholder contract
 * (reserved editor space, delayed hint).
 */

vi.mock('@/editor/note-editor', () => ({
  NoteEditor: () => <div data-testid="fake-editor" />,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    graph: { root: '/g', name: 'g', cloudSync: null, generation: 1 },
    indexing: false,
  }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: { dateFormat: 'mdy', editorMarkdownSyntax: 'hide', editorSpellCheck: true },
    updateSettings: async () => {},
  }),
}))

// virtua anchors by assigning `scrollTop` (not `scrollTo`); record the offsets it
// writes so a test can pin the first one. virtua computes the initial anchor from
// the `itemSize` estimate (nothing is measured yet at first paint), so the first
// offset is `index * ESTIMATED_DAY_HEIGHT` regardless of real row heights.
const scrollTops: number[] = []
let scrollTop = 0
Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
  configurable: true,
  get() {
    return scrollTop
  },
  set(value: number) {
    scrollTop = Number(value)
    scrollTops.push(scrollTop)
  },
})

setBridge({
  // Reads never resolve: every day stays a loading placeholder.
  invoke: () => new Promise(() => {}),
  listen: async () => () => {},
})

beforeEach(() => {
  scrollTops.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

function StreamProviders({ children }: { children: ReactNode }): ReactElement {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  )
  // The stream's scroll container is `h-full`; give it a real, fixed viewport so
  // virtua measures and anchors the way it does in the app.
  return (
    <QueryClientProvider client={client}>
      <RouterProvider initialRoute={{ kind: 'today' }}>
        <div style={{ height: '800px' }}>{children}</div>
      </RouterProvider>
    </QueryClientProvider>
  )
}

/** Records `offset` on the current history entry, as a view's scroll would. */
function SaveScrollProbe({ offset }: { offset: number }): ReactElement | null {
  const { saveScrollState } = useRouter()
  useEffect(() => {
    saveScrollState(offset)
  }, [saveScrollState, offset])
  return null
}

function NavigateTodayProbe({
  onReady,
}: {
  onReady: (navigateToday: () => void) => void
}): null {
  const { navigate } = useRouter()
  useEffect(() => {
    onReady(() => navigate({ kind: 'today' }))
  }, [navigate, onReady])
  return null
}

describe('DailyStream', () => {
  it('anchors its first scroll to today, with no top-of-window flicker', async () => {
    const today = todayIso()
    await render(
      <StreamProviders>
        <DailyStream target={{ kind: 'today' }} />
      </StreamProviders>,
    )

    const expected = indexOfDate(createDayWindow(today), today) * ESTIMATED_DAY_HEIGHT
    await vi.waitFor(() => expect(scrollTops.length).toBeGreaterThan(0))
    // The very first offset virtua applies is the anchor, not 0 (the top of the
    // window): the stream never paints the top and then jumps down to today.
    expect(scrollTops[0]).toBe(expected)
  })

  it('re-anchors a today arrival to the stream-local day after midnight', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 27, 23, 59, 0))
    let navigateToday: () => void = () => {
      throw new Error('navigate not ready')
    }
    await render(
      <StreamProviders>
        <DailyStream target={{ kind: 'today' }} />
        <NavigateTodayProbe
          onReady={(run) => {
            navigateToday = run
          }}
        />
      </StreamProviders>,
    )

    const dayWindow = createDayWindow('2026-06-27')
    await act(async () => {
      vi.advanceTimersByTime(2 * 60 * 1000)
    })
    scrollTops.length = 0

    await act(async () => {
      navigateToday()
    })

    const expected = indexOfDate(dayWindow, '2026-06-28') * ESTIMATED_DAY_HEIGHT
    expect(scrollTops.length).toBeGreaterThan(0)
    expect(scrollTops[0]).toBe(expected)
  })

  it('mounts straight at a restored entry’s saved offset, not the anchor', async () => {
    const view = await render(
      <StreamProviders>
        <SaveScrollProbe offset={4321} />
      </StreamProviders>,
    )
    scrollTops.length = 0

    await view.rerender(
      <StreamProviders>
        <SaveScrollProbe offset={4321} />
        <DailyStream target={{ kind: 'today' }} />
      </StreamProviders>,
    )

    await vi.waitFor(() => expect(scrollTops.length).toBeGreaterThan(0))
    expect(scrollTops[0]).toBe(4321)
  })

  it('reports the focused day so the sidebar can follow it within the stream', async () => {
    const today = todayIso()
    const dayWindow = createDayWindow(today)
    let focused: string | null = 'unset'
    function FocusProbe(): null {
      focused = useFocusedDailyDate()
      return null
    }
    const view = await render(
      <StreamProviders>
        <FocusedDailyProvider>
          <DailyStream target={{ kind: 'date', date: today }} />
          <FocusProbe />
        </FocusedDailyProvider>
      </StreamProviders>,
    )

    // Focus enters a stream row (the route is unchanged): the sidebar's day
    // must move to that row's date, not stay on the routed day.
    const row = await vi.waitFor(() => {
      const el = view.container.querySelector('[data-index]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    const date = dateAtIndex(dayWindow, Number(row.getAttribute('data-index')))
    await act(async () => {
      row.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })

    expect(focused).toBe(date)
  })

  it('reserves the editor’s space on loading placeholders, with the hint delayed', async () => {
    await render(
      <StreamProviders>
        <DailyStream target={{ kind: 'today' }} />
      </StreamProviders>,
    )

    await expect.element(page.getByText('Loading note…').first()).toBeInTheDocument()
    const placeholders = page.getByText('Loading note…').elements()
    expect(placeholders.length).toBeGreaterThan(0)
    for (const placeholder of placeholders) {
      expect(placeholder.className).toContain('reflect-note-loading')
      expect(placeholder.className).toMatch(/min-h-/)
    }
  })
})
