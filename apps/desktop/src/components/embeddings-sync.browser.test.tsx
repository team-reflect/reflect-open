import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
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

/** One macrotask — long enough for a would-be queue item to have started. */
function flushQueue(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('EmbeddingsSync', () => {
  it('backfills and follows the watcher while enabled and ready', async () => {
    await render(<EmbeddingsSync />)
    await vi.waitFor(() => expect(semantic.backfillEmbeddingsVisibly).toHaveBeenCalled())
    await vi.waitFor(() => expect(onFileChanges).not.toBeNull())

    onFileChanges?.([{ kind: 'upsert', path: 'notes/a.md' }])
    await vi.waitFor(() =>
      expect(core.embedNote).toHaveBeenCalledWith({
        path: 'notes/a.md',
        generation: 7,
        modelId: 'all-MiniLM-L6-v2',
      }),
    )
  })

  it('never embeds audio-memo recordings riding the same stream', async () => {
    await render(<EmbeddingsSync />)
    await vi.waitFor(() => expect(onFileChanges).not.toBeNull())

    onFileChanges?.([
      { kind: 'upsert', path: 'audio-memos/audio-memo-2026-06-12-090000-000.m4a' },
      { kind: 'remove', path: 'audio-memos/audio-memo-2026-06-12-091500-000.m4a' },
    ])
    await flushQueue()
    expect(core.embedNote).not.toHaveBeenCalled()
    expect(core.embedRemove).not.toHaveBeenCalled()
  })

  it('starts no embedding work while semantic search is disabled', async () => {
    semanticSetting.enabled = false
    await render(<EmbeddingsSync />)
    await flushQueue()
    expect(semantic.backfillEmbeddingsVisibly).not.toHaveBeenCalled()
    expect(core.subscribeFileChanges).not.toHaveBeenCalled()
  })

  it('pauses watcher work the moment semantic search is disabled', async () => {
    const view = await render(<EmbeddingsSync />)
    await vi.waitFor(() => expect(onFileChanges).not.toBeNull())

    semanticSetting.enabled = false
    await view.rerender(<EmbeddingsSync />)
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalled())

    // A batch still in flight when the teardown ran must be dropped, not
    // embedded behind the user's back.
    onFileChanges?.([{ kind: 'upsert', path: 'notes/b.md' }])
    await flushQueue()
    expect(core.embedNote).not.toHaveBeenCalled()
  })
})
