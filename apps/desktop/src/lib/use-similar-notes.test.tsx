import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import type { ReactNode } from 'react'
import type { RetrievalHit } from '@reflect/core'
import { INDEX_QUERY_SCOPE, SIMILAR_QUERY_SCOPE } from './query-client'
import { useSimilarNotes } from './use-similar-notes'

const relatedNotes = vi.hoisted(() => vi.fn())
const readNote = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  readNote,
  relatedNotes,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))
const semanticSetting = vi.hoisted(() => ({ enabled: true }))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: { semanticSearchEnabled: semanticSetting.enabled },
    updateSettings: () => {},
  }),
}))

function hit(path: string): RetrievalHit {
  return { path, title: path, score: 0.9, snippet: '', heading: null, isPrivate: false }
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

beforeEach(() => {
  semanticSetting.enabled = true
  readNote.mockReset().mockResolvedValue('- real entry\n')
  relatedNotes.mockReset().mockResolvedValue([hit('notes/a.md'), hit('notes/b.md')])
})

describe('useSimilarNotes', () => {
  it('returns a reference-stable array across re-renders when the data is unchanged', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result, rerender } = await renderHook(() => useSimilarNotes('notes/x.md'), {
      wrapper: wrapper(client),
    })

    await vi.waitFor(() => expect(result.current.length).toBe(2))
    const first = result.current

    // A re-render with no query change must not mint a fresh array — a new
    // reference each render would defeat memoization in every consumer.
    await rerender()
    expect(result.current).toBe(first)
    await rerender()
    expect(result.current).toBe(first)
  })

  it('returns an empty array (and never queries) while semantic search is off', async () => {
    semanticSetting.enabled = false
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result, rerender } = await renderHook(() => useSimilarNotes('notes/x.md'), {
      wrapper: wrapper(client),
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(relatedNotes).not.toHaveBeenCalled()
    const first = result.current
    expect(first).toEqual([])
    // The disabled path is stable too.
    await rerender()
    expect(result.current).toBe(first)
  })

  it('returns an empty array and never queries related notes for an empty daily note', async () => {
    readNote.mockResolvedValue('- \n')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = await renderHook(() => useSimilarNotes('daily/2026-06-09.md'), {
      wrapper: wrapper(client),
    })

    await vi.waitFor(() => expect(readNote).toHaveBeenCalledWith('daily/2026-06-09.md'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(relatedNotes).not.toHaveBeenCalled()
    expect(result.current).toEqual([])
  })

  it('does not recompute neighbors when index queries are invalidated', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = await renderHook(() => useSimilarNotes('notes/x.md'), {
      wrapper: wrapper(client),
    })

    await vi.waitFor(() => expect(result.current.length).toBe(2))
    expect(relatedNotes).toHaveBeenCalledTimes(1)

    // A neighbor lookup is up to seventeen vector KNN queries; unrelated graph
    // churn (a sync batch, a Git commit, the user's own typing) must not drag
    // it along, so it deliberately sits outside the index invalidation scope.
    await client.invalidateQueries({ queryKey: [INDEX_QUERY_SCOPE] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(relatedNotes).toHaveBeenCalledTimes(1)
  })

  it('recomputes an empty result on remount, but keeps found neighbors for the session', async () => {
    relatedNotes.mockResolvedValue([])
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const first = await renderHook(() => useSimilarNotes('notes/x.md'), {
      wrapper: wrapper(client),
    })

    await vi.waitFor(() => expect(relatedNotes).toHaveBeenCalledTimes(1))
    expect(first.result.current).toEqual([])
    await first.unmount()

    // "No neighbors" is never frozen: a note embedded after it was first
    // opened (a fresh note, a backfill still running) must be able to fill in.
    relatedNotes.mockResolvedValue([hit('notes/a.md')])
    const second = await renderHook(() => useSimilarNotes('notes/x.md'), {
      wrapper: wrapper(client),
    })
    await vi.waitFor(() => expect(second.result.current.length).toBe(1))
    expect(relatedNotes).toHaveBeenCalledTimes(2)
    await second.unmount()

    // Once they exist they hold for the session — a remount reads the cache.
    const third = await renderHook(() => useSimilarNotes('notes/x.md'), {
      wrapper: wrapper(client),
    })
    await vi.waitFor(() => expect(third.result.current.length).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(relatedNotes).toHaveBeenCalledTimes(2)
  })

  it('recomputes neighbors after a daily note is cleared and refilled', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const first = await renderHook(() => useSimilarNotes('daily/2026-06-09.md'), {
      wrapper: wrapper(client),
    })
    await vi.waitFor(() => expect(first.result.current.length).toBe(2))
    expect(relatedNotes).toHaveBeenCalledTimes(1)
    await first.unmount()

    // The daily's body is wiped: the emptiness gate closes, and the cached
    // neighbors — they describe the deleted content — must be dropped with it.
    readNote.mockResolvedValue('- \n')
    const cleared = await renderHook(() => useSimilarNotes('daily/2026-06-09.md'), {
      wrapper: wrapper(client),
    })
    const similarKey = [SIMILAR_QUERY_SCOPE, '/g', 'daily/2026-06-09.md']
    await vi.waitFor(() => expect(client.getQueryData(similarKey)).toBeUndefined())
    expect(cleared.result.current).toEqual([])
    await cleared.unmount()

    // New content arrives: the refill computes fresh instead of serving the
    // old note's neighbors from the session cache.
    readNote.mockResolvedValue('- rewritten entry\n')
    relatedNotes.mockResolvedValue([hit('notes/c.md')])
    const refilled = await renderHook(() => useSimilarNotes('daily/2026-06-09.md'), {
      wrapper: wrapper(client),
    })
    await vi.waitFor(() =>
      expect(refilled.result.current.map((h) => h.path)).toEqual(['notes/c.md']),
    )
    expect(relatedNotes).toHaveBeenCalledTimes(2)
  })

  it('queries related notes for a daily note once it has authored content', async () => {
    readNote.mockResolvedValue('- real entry\n')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = await renderHook(() => useSimilarNotes('daily/2026-06-09.md'), {
      wrapper: wrapper(client),
    })

    await vi.waitFor(() => expect(result.current.length).toBe(2))
    expect(readNote).toHaveBeenCalledWith('daily/2026-06-09.md')
    expect(relatedNotes).toHaveBeenCalledWith('daily/2026-06-09.md', 6)
  })
})
