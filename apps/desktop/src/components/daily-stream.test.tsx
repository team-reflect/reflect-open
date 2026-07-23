import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { setBridge } from '@reflect/core'
import {
  FocusedDailyProvider,
  useFocusedDailyDate,
} from '@/providers/focused-daily-provider'
import { RouterProvider, useRouter } from '@/routing/router'
import { formatDayLabel, todayIso } from '@/lib/dates'
import { createDayWindow, dateAtIndex, indexOfDate } from '@/lib/day-window'
import { fireEvent } from '@/test-utils/fire-event'
import '@/test-utils/locator'
import { DailyStream, ESTIMATED_DAY_HEIGHT } from './daily-stream'

/**
 * The stream's first-paint anchor: virtua must put the scroll element at the
 * target day (or a back/forward entry's saved offset) before paint, so opening
 * the app never shows the top of the five-year window and then lurches down to
 * today. virtua applies an imperative scroll by assigning `scrollTop` in a
 * microtask. These tests assert the resulting real browser layout and also
 * cover the loading-placeholder contract (reserved editor space, delayed hint).
 */

vi.mock('@/editor/note-editor', () => ({
  NoteEditor: () => <div data-testid="fake-editor" />,
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
      dateFormat: 'mdy',
      editorMarkdownSyntax: 'hide',
      editorSpellCheck: true,
      aiProviders: [],
      defaultAiProviderId: null,
      chatSystemPrompt: '',
      aiPrompts: [],
    },
    updateSettings: async () => {},
    updateSettingsWith: () => {},
  }),
}))

setBridge({
  // Reads never resolve: every day stays a loading placeholder.
  invoke: () => new Promise(() => {}),
  listen: async () => () => {},
})

afterEach(async () => {
  await cleanup()
  vi.useRealTimers()
})

function StreamProviders({ children }: { children: ReactNode }): ReactElement {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  )
  return (
    <QueryClientProvider client={client}>
      <RouterProvider initialRoute={{ kind: 'today' }}>
        <div style={{ height: 800 }}>{children}</div>
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
    const view = await render(
      <StreamProviders>
        <DailyStream target={{ kind: 'today' }} />
      </StreamProviders>,
    )

    const stream = page.getByTestId('daily-stream')
    await vi.waitFor(() => expect(stream.element().scrollTop).toBeGreaterThan(0))
    await expect.element(page.getByText(formatDayLabel(today, 'mdy'))).toBeVisible()
    await view.unmount()
  })

  it('re-anchors a today arrival to the stream-local day after midnight', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 27, 23, 59, 0))
    let navigateToday: () => void = () => {
      throw new Error('navigate not ready')
    }
    const view = await render(
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
    await act(async () => {
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

  it('mounts straight at a restored entry’s saved offset, not the anchor', async () => {
    const view = await render(
      <StreamProviders>
        <SaveScrollProbe offset={4321} />
      </StreamProviders>,
    )
    await view.rerender(
      <StreamProviders>
        <SaveScrollProbe offset={4321} />
        <DailyStream target={{ kind: 'today' }} />
      </StreamProviders>,
    )

    await vi.waitFor(() =>
      expect(page.getByTestId('daily-stream').element().scrollTop).toBeCloseTo(4321, -1),
    )
    await view.unmount()
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
    await act(() => {
      fireEvent.focusIn(row)
    })

    expect(focused).toBe(date)
    await view.unmount()
  })

  it('reserves the editor’s space on loading placeholders, with the hint delayed', async () => {
    const view = await render(
      <StreamProviders>
        <DailyStream target={{ kind: 'today' }} />
      </StreamProviders>,
    )

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
