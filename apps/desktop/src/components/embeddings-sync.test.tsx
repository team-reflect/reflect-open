import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileChange } from '@reflect/core'
import { EmbeddingsSync } from './embeddings-sync'

const core = vi.hoisted(() => ({
  embedNote: vi.fn(async () => ({ written: 0 })),
  embedRemove: vi.fn(async () => {}),
  subscribeFileChanges: vi.fn(),
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  embedNote: core.embedNote,
  embedRemove: core.embedRemove,
  subscribeFileChanges: core.subscribeFileChanges,
}))

const semantic = vi.hoisted(() => ({
  backfillEmbeddingsVisibly: vi.fn(async () => 'completed' as const),
  consumeLegacySemanticOptIn: vi.fn(() => false),
  ensureEmbeddingsVisibly: vi.fn(async () => ({ status: 'ready', model: 'all-MiniLM-L6-v2' })),
}))
vi.mock('@/lib/semantic', () => semantic)

vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    graph: { root: '/g', name: 'g', cloudSync: null, generation: 1 },
    indexGeneration: 7,
  }),
}))
const semanticSetting = vi.hoisted(() => ({ enabled: true }))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: { semanticSearchEnabled: semanticSetting.enabled },
    updateSettings: () => {},
  }),
}))
vi.mock('@/lib/use-embed-status', () => ({
  useEmbedStatus: () => ({ status: 'ready', model: 'all-MiniLM-L6-v2' }),
}))

let onFileChanges: ((changes: FileChange[]) => void) | null = null
const unlisten = vi.fn()

beforeEach(() => {
  semanticSetting.enabled = true
  onFileChanges = null
  unlisten.mockClear()
  core.embedNote.mockClear()
  core.embedRemove.mockClear()
  semantic.backfillEmbeddingsVisibly.mockClear()
  core.subscribeFileChanges
    .mockReset()
    .mockImplementation(async (handler: (changes: FileChange[]) => void) => {
      onFileChanges = handler
      return unlisten
    })
})

afterEach(cleanup)

/** One macrotask — long enough for a would-be queue item to have started. */
function flushQueue(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('EmbeddingsSync', () => {
  it('backfills and follows the watcher while enabled and ready', async () => {
    render(<EmbeddingsSync />)
    await waitFor(() => expect(semantic.backfillEmbeddingsVisibly).toHaveBeenCalled())
    await waitFor(() => expect(onFileChanges).not.toBeNull())

    onFileChanges?.([{ kind: 'upsert', path: 'notes/a.md' }])
    await waitFor(() =>
      expect(core.embedNote).toHaveBeenCalledWith({
        path: 'notes/a.md',
        generation: 7,
        modelId: 'all-MiniLM-L6-v2',
      }),
    )
  })

  it('starts no embedding work while semantic search is disabled', async () => {
    semanticSetting.enabled = false
    render(<EmbeddingsSync />)
    await flushQueue()
    expect(semantic.backfillEmbeddingsVisibly).not.toHaveBeenCalled()
    expect(core.subscribeFileChanges).not.toHaveBeenCalled()
  })

  it('pauses watcher work the moment semantic search is disabled', async () => {
    const view = render(<EmbeddingsSync />)
    await waitFor(() => expect(onFileChanges).not.toBeNull())

    semanticSetting.enabled = false
    view.rerender(<EmbeddingsSync />)
    await waitFor(() => expect(unlisten).toHaveBeenCalled())

    // A batch still in flight when the teardown ran must be dropped, not
    // embedded behind the user's back.
    onFileChanges?.([{ kind: 'upsert', path: 'notes/b.md' }])
    await flushQueue()
    expect(core.embedNote).not.toHaveBeenCalled()
  })
})
