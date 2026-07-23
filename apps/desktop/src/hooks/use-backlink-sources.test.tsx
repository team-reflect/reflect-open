import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import type { ReactNode } from 'react'
import type { BacklinkContext, BacklinkContextPage } from '@reflect/core'
import { useBacklinkSources } from './use-backlink-sources'

const getBacklinksWithContext = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getBacklinksWithContext,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))

function context(sourcePath: string, snippet: string, posFrom: number): BacklinkContext {
  return {
    sourcePath,
    sourceTitle: sourcePath,
    snippet,
    posFrom,
    tasks: [],
  }
}

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

beforeEach(() => {
  getBacklinksWithContext.mockReset()
})

describe('useBacklinkSources', () => {
  it('loads source pages, deduplicates overlapping contexts, and preserves the indexed count', async () => {
    const nextCursor = { recencyMs: 100, sourcePath: 'notes/a.md' }
    let resolveNextPage: ((page: BacklinkContextPage) => void) | undefined
    const nextPage = new Promise<BacklinkContextPage>((resolve) => {
      resolveNextPage = resolve
    })
    getBacklinksWithContext.mockImplementation(
      (_path: string, options: { cursor: typeof nextCursor | null }) =>
        options.cursor === null
          ? Promise.resolve({
              contexts: [
                context('notes/a.md', 'shared context', 1),
                context('notes/a.md', 'first-page context', 2),
              ],
              nextCursor,
              indexedLinkCount: 12,
            })
          : nextPage,
    )

    const { result, act } = await renderHook(() => useBacklinkSources('notes/target.md'), {
      wrapper: makeWrapper(),
    })

    await vi.waitFor(() => expect(result.current.groups).toHaveLength(1))
    expect(getBacklinksWithContext).toHaveBeenNthCalledWith(1, 'notes/target.md', {
      cursor: null,
      limit: 10,
    })
    expect(result.current.count).toBe(12)
    expect(result.current.hasNextPage).toBe(true)

    await act(() => {
      result.current.loadMore()
      result.current.loadMore()
    })
    await vi.waitFor(() => expect(result.current.isFetchingNextPage).toBe(true))
    expect(getBacklinksWithContext).toHaveBeenCalledTimes(2)
    expect(getBacklinksWithContext).toHaveBeenNthCalledWith(2, 'notes/target.md', {
      cursor: nextCursor,
      limit: 10,
    })

    await act(async () => {
      resolveNextPage?.({
        contexts: [
          context('notes/a.md', 'shared context', 1),
          context('notes/b.md', 'second-page context', 3),
        ],
        nextCursor: null,
        indexedLinkCount: 99,
      })
      await nextPage
    })

    await vi.waitFor(() => expect(result.current.isFetchingNextPage).toBe(false))
    expect(result.current.groups).toEqual([
      {
        path: 'notes/a.md',
        title: 'notes/a.md',
        snippets: [
          { key: 'notes/a.md:1', text: 'shared context', tasks: [] },
          { key: 'notes/a.md:2', text: 'first-page context', tasks: [] },
        ],
      },
      {
        path: 'notes/b.md',
        title: 'notes/b.md',
        snippets: [{ key: 'notes/b.md:3', text: 'second-page context', tasks: [] }],
      },
    ])
    expect(result.current.count).toBe(12)
    expect(result.current.hasNextPage).toBe(false)
  })

  it('keeps loaded groups usable when loading the next page fails', async () => {
    const nextCursor = { recencyMs: 100, sourcePath: 'notes/a.md' }
    getBacklinksWithContext
      .mockResolvedValueOnce({
        contexts: [context('notes/a.md', 'loaded context', 1)],
        nextCursor,
        indexedLinkCount: 2,
      })
      .mockRejectedValueOnce(new Error('next page failed'))

    const { result, act } = await renderHook(() => useBacklinkSources('notes/target.md'), {
      wrapper: makeWrapper(),
    })
    await vi.waitFor(() => expect(result.current.groups).toHaveLength(1))

    await act(() => result.current.loadMore())
    await vi.waitFor(() => expect(result.current.isFetchNextPageError).toBe(true))

    expect(result.current.isError).toBe(false)
    expect(result.current.groups).toHaveLength(1)
    expect(result.current.count).toBe(2)
  })

  it('reports an initial-page failure as the panel error', async () => {
    getBacklinksWithContext.mockRejectedValue(new Error('initial page failed'))

    const { result } = await renderHook(() => useBacklinkSources('notes/target.md'), {
      wrapper: makeWrapper(),
    })
    await vi.waitFor(() => expect(result.current.isError).toBe(true))

    expect(result.current.isFetchNextPageError).toBe(false)
    expect(result.current.groups).toEqual([])
    expect(result.current.count).toBe(0)
  })
})
