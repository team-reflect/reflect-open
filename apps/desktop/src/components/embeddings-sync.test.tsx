import { render } from 'vitest-browser-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BackfillEmbeddingsOptions,
  EmbedNoteOptions,
  IndexAppliedListener,
} from '@reflect/core'
import { EmbeddingsSync } from './embeddings-sync'

const core = vi.hoisted(() => ({
  embedNote: vi.fn<(options: EmbedNoteOptions) => Promise<number>>(async () => 0),
  embedRemove: vi.fn(async () => {}),
  subscribeIndexApplied: vi.fn(),
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  embedNote: core.embedNote,
  embedRemove: core.embedRemove,
  subscribeIndexApplied: core.subscribeIndexApplied,
}))

const semantic = vi.hoisted(() => ({
  backfillEmbeddingsVisibly: vi.fn<
    (options: BackfillEmbeddingsOptions) => Promise<'completed' | 'aborted' | 'failed'>
  >(async () => 'completed'),
  consumeLegacySemanticOptIn: vi.fn(() => false),
  ensureEmbeddingsVisibly: vi.fn(async () => ({ status: 'ready', model: 'all-MiniLM-L6-v2' })),
}))
vi.mock('@/lib/semantic', () => semantic)

vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    graph: { root: '/g', name: 'g', generation: 1 },
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

let onApplied: IndexAppliedListener | null = null
const unlisten = vi.fn()

beforeEach(() => {
  semanticSetting.enabled = true
  onApplied = null
  unlisten.mockClear()
  core.embedNote.mockReset().mockResolvedValue(0)
  core.embedRemove.mockClear()
  semantic.backfillEmbeddingsVisibly.mockReset().mockResolvedValue('completed')
  core.subscribeIndexApplied.mockReset().mockImplementation((handler: IndexAppliedListener) => {
    onApplied = handler
    return unlisten
  })
})

/** One macrotask — long enough for a would-be queue item to have started. */
function flushQueue(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function pauseWork(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('EmbeddingsSync', () => {
  it('backfills and follows applied index batches while enabled and ready', async () => {
    await render(<EmbeddingsSync />)
    await vi.waitFor(() => expect(semantic.backfillEmbeddingsVisibly).toHaveBeenCalled())
    await vi.waitFor(() => expect(onApplied).not.toBeNull())

    onApplied?.([{ kind: 'upsert', path: 'notes/a.md' }], 7)
    await vi.waitFor(() =>
      expect(core.embedNote).toHaveBeenCalledWith({
        path: 'notes/a.md',
        generation: 7,
        modelId: 'all-MiniLM-L6-v2',
        isStale: expect.any(Function),
      }),
    )
  })

  it('coalesces repeated live paths and preserves one follow-up for an in-flight save', async () => {
    const paused = pauseWork()
    core.embedNote.mockImplementationOnce(async () => {
      await paused.promise
      return 0
    })
    await render(<EmbeddingsSync />)
    await vi.waitFor(() => expect(semantic.backfillEmbeddingsVisibly).toHaveBeenCalled())
    onApplied?.([{ kind: 'upsert', path: 'notes/a.md' }], 7)
    await vi.waitFor(() => expect(core.embedNote).toHaveBeenCalledTimes(1))
    onApplied?.(
      [
        { kind: 'upsert', path: 'notes/a.md' },
        { kind: 'upsert', path: 'notes/a.md' },
        { kind: 'upsert', path: 'notes/a.md' },
      ],
      7,
    )
    paused.release()
    await vi.waitFor(() => expect(core.embedNote).toHaveBeenCalledTimes(2))
    await flushQueue()
    expect(core.embedNote).toHaveBeenCalledTimes(2)
  })

  it('processes live changes between bulk notes', async () => {
    const firstBulk = pauseWork()
    const order: string[] = []
    semantic.backfillEmbeddingsVisibly.mockImplementationOnce(async (options) => {
      await options.scheduleNote?.(async () => {
        order.push('bulk-first')
        await firstBulk.promise
      })
      await options.scheduleNote?.(async () => {
        order.push('bulk-second')
      })
      return 'completed'
    })
    core.embedNote.mockImplementation(async ({ path }) => {
      order.push(path)
      return 0
    })
    await render(<EmbeddingsSync />)
    await vi.waitFor(() => expect(order).toEqual(['bulk-first']))
    onApplied?.([{ kind: 'upsert', path: 'notes/live.md' }], 7)
    firstBulk.release()
    await vi.waitFor(() => expect(order).toEqual(['bulk-first', 'notes/live.md', 'bulk-second']))
  })

  it('processes live changes while bulk candidate discovery is still pending', async () => {
    const discovery = pauseWork()
    const order: string[] = []
    semantic.backfillEmbeddingsVisibly.mockImplementationOnce(async (options) => {
      order.push('discovering')
      await discovery.promise
      await options.scheduleNote?.(async () => {
        order.push('bulk-note')
      })
      return 'completed'
    })
    core.embedNote.mockImplementation(async ({ path }) => {
      order.push(path)
      return 0
    })
    await render(<EmbeddingsSync />)
    await vi.waitFor(() => expect(order).toEqual(['discovering']))
    onApplied?.([{ kind: 'upsert', path: 'notes/live.md' }], 7)
    await vi.waitFor(() => expect(order).toEqual(['discovering', 'notes/live.md']))
    discovery.release()
    await vi.waitFor(() => expect(order).toEqual(['discovering', 'notes/live.md', 'bulk-note']))
  })

  it('drops deleted pending work and never schedules a destructive delayed remove', async () => {
    const paused = pauseWork()
    core.embedNote.mockImplementationOnce(async () => {
      await paused.promise
      return 0
    })
    await render(<EmbeddingsSync />)
    await vi.waitFor(() => expect(semantic.backfillEmbeddingsVisibly).toHaveBeenCalled())
    onApplied?.([{ kind: 'upsert', path: 'notes/first.md' }], 7)
    await vi.waitFor(() => expect(core.embedNote).toHaveBeenCalledTimes(1))
    onApplied?.([{ kind: 'upsert', path: 'notes/deleted.md' }], 7)
    onApplied?.([{ kind: 'remove', path: 'notes/deleted.md' }], 7)
    onApplied?.([{ kind: 'remove', path: 'notes/recreated.md' }], 7)
    onApplied?.([{ kind: 'upsert', path: 'notes/recreated.md' }], 7)
    paused.release()
    await vi.waitFor(() => expect(core.embedNote).toHaveBeenCalledTimes(2))
    expect(core.embedNote.mock.calls.map(([options]) => options.path)).toEqual([
      'notes/first.md',
      'notes/recreated.md',
    ])
    expect(core.embedRemove).not.toHaveBeenCalled()
  })

  it('ignores a delayed emit from a superseded index session', async () => {
    await render(<EmbeddingsSync />)
    await vi.waitFor(() => expect(onApplied).not.toBeNull())

    onApplied?.([{ kind: 'upsert', path: 'notes/a.md' }], 6)
    await flushQueue()
    expect(core.embedNote).not.toHaveBeenCalled()
  })

  it('never embeds asset-file changes riding the same batches', async () => {
    await render(<EmbeddingsSync />)
    await vi.waitFor(() => expect(onApplied).not.toBeNull())

    onApplied?.(
      [
        { kind: 'upsert', path: 'assets/photo.png' },
        { kind: 'remove', path: 'assets/old.pdf' },
      ],
      7,
    )
    await flushQueue()
    expect(core.embedNote).not.toHaveBeenCalled()
    expect(core.embedRemove).not.toHaveBeenCalled()
  })

  it('starts no embedding work while semantic search is disabled', async () => {
    semanticSetting.enabled = false
    await render(<EmbeddingsSync />)
    await flushQueue()
    expect(semantic.backfillEmbeddingsVisibly).not.toHaveBeenCalled()
    expect(core.subscribeIndexApplied).not.toHaveBeenCalled()
  })

  it('pauses follow-up work the moment semantic search is disabled', async () => {
    const view = await render(<EmbeddingsSync />)
    await vi.waitFor(() => expect(onApplied).not.toBeNull())

    semanticSetting.enabled = false
    await view.rerender(<EmbeddingsSync />)
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalled())

    // A batch still in flight when the teardown ran must be dropped, not
    // embedded behind the user's back.
    onApplied?.([{ kind: 'upsert', path: 'notes/b.md' }], 7)
    await flushQueue()
    expect(core.embedNote).not.toHaveBeenCalled()
  })
})
