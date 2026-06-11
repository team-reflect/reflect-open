import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { setBridge } from '@reflect/core'
import { RouterProvider, useRouter } from '@/routing/router'
import { todayIso } from '@/lib/dates'
import { createDayWindow, indexOfDate } from '@/lib/day-window'
import { DailyStream, ESTIMATED_DAY_HEIGHT } from './daily-stream'

/**
 * The stream's first-paint anchor: the virtualizer's `initialOffset` must put
 * the scroll element at the target day (or a back/forward entry's saved
 * offset) in the mount layout effect — before paint — so opening the app never
 * paints the top of the five-year window and then visibly lurches down to
 * today. These tests pin the *first* scroll command the stream issues; the
 * jsdom environment never resolves a note read, so they also cover the
 * loading-placeholder contract (reserved editor space, delayed hint).
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
    settings: { dateFormat: 'mdy', editorMarkdownSyntax: 'always', editorSpellCheck: true },
    updateSettings: async () => {},
  }),
}))

// jsdom implements neither — the virtualizer needs both.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
const scrollToSpy = vi.fn()
Element.prototype.scrollTo = scrollToSpy as unknown as typeof Element.prototype.scrollTo

// jsdom has no layout, so every offsetHeight is 0 — the virtualizer then
// computes an empty range and renders no rows. Give the scroll container a
// viewport and let each row measure exactly the estimate, so the range around
// the anchor is rendered without any size-correction churn.
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get(this: HTMLElement) {
    return this.dataset['testid'] === 'daily-stream' ? 800 : ESTIMATED_DAY_HEIGHT
  },
})

setBridge({
  // Reads never resolve: every day stays a loading placeholder.
  invoke: () => new Promise(() => {}),
  listen: async () => () => {},
})

beforeEach(() => {
  scrollToSpy.mockClear()
})

function StreamProviders({ children }: { children: ReactNode }): ReactElement {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  )
  return (
    <QueryClientProvider client={client}>
      <RouterProvider initialRoute={{ kind: 'today' }}>{children}</RouterProvider>
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

describe('DailyStream', () => {
  it('issues the anchor-to-today offset as its very first scroll command', () => {
    const today = todayIso()
    const view = render(
      <StreamProviders>
        <DailyStream targetDate={today} />
      </StreamProviders>,
    )

    const expected = indexOfDate(createDayWindow(today), today) * ESTIMATED_DAY_HEIGHT
    expect(scrollToSpy.mock.calls.length).toBeGreaterThan(0)
    expect(scrollToSpy.mock.calls[0][0]).toMatchObject({ top: expected })
    view.unmount()
  })

  it('mounts straight at a restored entry’s saved offset, not the anchor', () => {
    const view = render(
      <StreamProviders>
        <SaveScrollProbe offset={4321} />
      </StreamProviders>,
    )
    scrollToSpy.mockClear()

    view.rerender(
      <StreamProviders>
        <SaveScrollProbe offset={4321} />
        <DailyStream targetDate={todayIso()} />
      </StreamProviders>,
    )

    expect(scrollToSpy.mock.calls.length).toBeGreaterThan(0)
    expect(scrollToSpy.mock.calls[0][0]).toMatchObject({ top: 4321 })
    view.unmount()
  })

  it('reserves the editor’s space on loading placeholders, with the hint delayed', () => {
    const view = render(
      <StreamProviders>
        <DailyStream targetDate={todayIso()} />
      </StreamProviders>,
    )

    const placeholders = view.getAllByText('Loading note…')
    expect(placeholders.length).toBeGreaterThan(0)
    for (const placeholder of placeholders) {
      expect(placeholder.className).toContain('reflect-note-loading')
      expect(placeholder.className).toMatch(/min-h-/)
    }
    view.unmount()
  })
})
