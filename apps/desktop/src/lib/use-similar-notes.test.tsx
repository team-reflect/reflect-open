import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { RetrievalHit } from '@reflect/core'
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
    const { result, rerender } = renderHook(() => useSimilarNotes('notes/x.md'), {
      wrapper: wrapper(client),
    })

    await waitFor(() => expect(result.current.length).toBe(2))
    const first = result.current

    // A re-render with no query change must not mint a fresh array — a new
    // reference each render would defeat memoization in every consumer.
    rerender()
    expect(result.current).toBe(first)
    rerender()
    expect(result.current).toBe(first)
  })

  it('returns an empty array (and never queries) while semantic search is off', async () => {
    semanticSetting.enabled = false
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result, rerender } = renderHook(() => useSimilarNotes('notes/x.md'), {
      wrapper: wrapper(client),
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(relatedNotes).not.toHaveBeenCalled()
    const first = result.current
    expect(first).toEqual([])
    // The disabled path is stable too.
    rerender()
    expect(result.current).toBe(first)
  })

  it('returns an empty array and never queries related notes for an empty daily note', async () => {
    readNote.mockResolvedValue('- \n')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useSimilarNotes('daily/2026-06-09.md'), {
      wrapper: wrapper(client),
    })

    await waitFor(() => expect(readNote).toHaveBeenCalledWith('daily/2026-06-09.md'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(relatedNotes).not.toHaveBeenCalled()
    expect(result.current).toEqual([])
  })

  it('queries related notes for a daily note once it has authored content', async () => {
    readNote.mockResolvedValue('- real entry\n')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useSimilarNotes('daily/2026-06-09.md'), {
      wrapper: wrapper(client),
    })

    await waitFor(() => expect(result.current.length).toBe(2))
    expect(readNote).toHaveBeenCalledWith('daily/2026-06-09.md')
    expect(relatedNotes).toHaveBeenCalledWith('daily/2026-06-09.md', 6)
  })
})
