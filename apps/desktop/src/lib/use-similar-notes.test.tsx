import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmbedStatus, RetrievalHit } from '@reflect/core'
import {
  createTestCoreServices,
  createTestEmbeddingRuntimeService,
  createTestNoteFileService,
  createTestRetrievalService,
  type TestNoteFileService,
} from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { queryKeys } from './query-client.ts'
import { useSimilarNotes } from './use-similar-notes.ts'

const DAILY = 'daily/2026-06-09.md'

function hit(path: string): RetrievalHit {
  return { path, title: path, score: 0.9, snippet: '', heading: null, isPrivate: false }
}

const relatedNotes = vi.fn<(path: string, limit?: number) => Promise<RetrievalHit[]>>()
let noteFile: TestNoteFileService
let embedStatus: EmbedStatus
let semanticSearchEnabled: boolean

beforeEach(() => {
  semanticSearchEnabled = true
  embedStatus = { status: 'uninitialized' }
  noteFile = createTestNoteFileService({ files: { [DAILY]: '- real entry\n' } })
  relatedNotes.mockReset().mockResolvedValue([hit('notes/a.md'), hit('notes/b.md')])
})

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

/**
 * Mount the hook for `path` over the fakes above; `client` carries the session cache across mounts.
 */
async function mount(path: string, client: QueryClient) {
  const embeddingRuntime = createTestEmbeddingRuntimeService({ status: embedStatus })
  // The runtime has reported before the mount, as on a second visit to a note.
  await embeddingRuntime.status()
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    noteFile,
    retrieval: createTestRetrievalService({ relatedNotes }),
    embeddingRuntime,
  })
  return await renderHookInApp(() => useSimilarNotes(path), {
    app,
    graph: { root: '/g', name: 'g' },
    settings: { semanticSearchEnabled },
    queryClient: client,
  })
}

function readPaths(): string[] {
  return noteFile.getReads().map((read) => read.path)
}

describe('useSimilarNotes', () => {
  it('returns a reference-stable array across re-renders when the data is unchanged', async () => {
    const client = newClient()
    const { result, rerender } = await mount('notes/x.md', client)

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
    semanticSearchEnabled = false
    const client = newClient()
    const { result, rerender } = await mount('notes/x.md', client)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(relatedNotes).not.toHaveBeenCalled()
    const first = result.current
    expect(first).toEqual([])
    // The disabled path is stable too.
    await rerender()
    expect(result.current).toBe(first)
  })

  it('never queries related notes without an embedding runtime', async () => {
    embedStatus = { status: 'unsupported' }
    const client = newClient()
    const { result } = await mount('notes/x.md', client)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(relatedNotes).not.toHaveBeenCalled()
    expect(result.current).toEqual([])
  })

  it('returns an empty array and never queries related notes for an empty daily note', async () => {
    noteFile.set(DAILY, '- \n')
    const client = newClient()
    const { result } = await mount('daily/2026-06-09.md', client)

    await vi.waitFor(() => expect(readPaths()).toContain(DAILY))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(relatedNotes).not.toHaveBeenCalled()
    expect(result.current).toEqual([])
  })

  it('does not recompute neighbors when index queries are invalidated', async () => {
    const client = newClient()
    const { result } = await mount('notes/x.md', client)

    await vi.waitFor(() => expect(result.current.length).toBe(2))
    expect(relatedNotes).toHaveBeenCalledTimes(1)

    // A neighbor lookup is up to seventeen vector KNN queries; unrelated graph
    // churn (a sync batch, a Git commit, the user's own typing) must not drag
    // it along, so it deliberately sits outside the index invalidation scope.
    await client.invalidateQueries({ queryKey: queryKeys.index.all })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(relatedNotes).toHaveBeenCalledTimes(1)
  })

  it('recomputes an empty result on remount, but keeps found neighbors for the session', async () => {
    relatedNotes.mockResolvedValue([])
    const client = newClient()
    const first = await mount('notes/x.md', client)

    await vi.waitFor(() => expect(relatedNotes).toHaveBeenCalledTimes(1))
    expect(first.result.current).toEqual([])
    await first.unmount()

    // "No neighbors" is never frozen: a note embedded after it was first
    // opened (a fresh note, a backfill still running) must be able to fill in.
    relatedNotes.mockResolvedValue([hit('notes/a.md')])
    const second = await mount('notes/x.md', client)
    await vi.waitFor(() => expect(second.result.current.length).toBe(1))
    expect(relatedNotes).toHaveBeenCalledTimes(2)
    await second.unmount()

    // Once they exist they hold for the session — a remount reads the cache.
    const third = await mount('notes/x.md', client)
    await vi.waitFor(() => expect(third.result.current.length).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(relatedNotes).toHaveBeenCalledTimes(2)
  })

  it('recomputes neighbors after a daily note is cleared and refilled', async () => {
    const client = newClient()
    const first = await mount('daily/2026-06-09.md', client)
    await vi.waitFor(() => expect(first.result.current.length).toBe(2))
    expect(relatedNotes).toHaveBeenCalledTimes(1)
    await first.unmount()

    // The daily's body is wiped: the emptiness gate closes, and the cached
    // neighbors — they describe the deleted content — must be dropped with it.
    noteFile.set(DAILY, '- \n')
    const cleared = await mount('daily/2026-06-09.md', client)
    const similarKey = queryKeys.similar.note('/g', 'daily/2026-06-09.md')
    await vi.waitFor(() => expect(client.getQueryData(similarKey)).toBeUndefined())
    expect(cleared.result.current).toEqual([])
    await cleared.unmount()

    // New content arrives: the refill computes fresh instead of serving the
    // old note's neighbors from the session cache.
    noteFile.set(DAILY, '- rewritten entry\n')
    relatedNotes.mockResolvedValue([hit('notes/c.md')])
    const refilled = await mount('daily/2026-06-09.md', client)
    await vi.waitFor(() => {
      expect(refilled.result.current.map((h) => h.path)).toEqual(['notes/c.md'])
    })
    expect(relatedNotes).toHaveBeenCalledTimes(2)
  })

  it('queries related notes for a daily note once it has authored content', async () => {
    const client = newClient()
    const { result } = await mount('daily/2026-06-09.md', client)

    await vi.waitFor(() => expect(result.current.length).toBe(2))
    expect(readPaths()).toContain(DAILY)
    expect(relatedNotes).toHaveBeenCalledWith('daily/2026-06-09.md', 6)
  })
})
