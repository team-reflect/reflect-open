import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AiProvidersState,
  FileChange,
  ReconcileAssetDescriptionsInput,
  ReconcileAssetDescriptionsOutcome,
} from '@reflect/core'
import {
  createAssetDescribeController,
  type AssetDescribeController,
} from './asset-describe-controller'

const reconcileAssetDescriptions = vi.hoisted(() =>
  vi.fn<(input: ReconcileAssetDescriptionsInput) => Promise<ReconcileAssetDescriptionsOutcome>>(),
)
const subscribeIndexApplied = vi.hoisted(() =>
  vi.fn<(handler: (changes: readonly FileChange[]) => void) => () => void>(),
)
const readNote = vi.hoisted(() => vi.fn<(path: string, generation?: number) => Promise<string>>())
const reindexNotesReferencing = vi.hoisted(() =>
  vi.fn<(assetPaths: readonly string[], generation: number) => Promise<void>>(),
)
const failOperation = vi.hoisted(() => vi.fn<(message: string) => void>())
const invalidateIndexQueries = vi.hoisted(() => vi.fn<() => void>())

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  reconcileAssetDescriptions,
  subscribeIndexApplied,
  readNote,
  reindexNotesReferencing,
  hasBridge: () => true,
}))
vi.mock('@/lib/provider-fetch', () => ({
  providerFetch: vi.fn(),
}))
vi.mock('@/lib/operations', () => ({
  startOperation: () => ({ progress: vi.fn(), done: vi.fn(), fail: failOperation }),
}))
vi.mock('@/lib/query-client', () => ({
  invalidateIndexQueries,
}))

const PROVIDERS: AiProvidersState = {
  providers: [{ id: 'cfg-anthropic', provider: 'anthropic', model: 'claude-opus-4-8', keyHint: 'wxyz1' }],
  defaultProviderId: 'cfg-anthropic',
}

function outcome(overrides: Partial<ReconcileAssetDescriptionsOutcome> = {}): ReconcileAssetDescriptionsOutcome {
  return {
    pending: 1,
    described: 1,
    skippedUpToDate: 0,
    skippedUnreferenced: 0,
    skippedPrivate: 0,
    skippedUserAuthored: 0,
    skippedOversize: 0,
    refused: 0,
    describedAssetPaths: [],
    stopped: null,
    ...overrides,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function upsert(path: string): FileChange {
  return { path, kind: 'upsert', modifiedMs: 1 }
}

const GEN = 3
let onApplied: ((changes: readonly FileChange[], generation: number) => void) | null = null
const unlisten = vi.fn()
let controller: AssetDescribeController | null = null

function create(): AssetDescribeController {
  controller = createAssetDescribeController({ generation: GEN, getProviders: () => PROVIDERS })
  return controller
}

/** Deliver a post-apply batch at the controller's generation (the common case). */
function emitApplied(changes: FileChange[]): void {
  onApplied?.(changes, GEN)
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.clearAllMocks()
  onApplied = null
  reconcileAssetDescriptions.mockResolvedValue(outcome())
  reindexNotesReferencing.mockResolvedValue(undefined)
  readNote.mockResolvedValue('# A note with no asset references\n')
  subscribeIndexApplied.mockImplementation((handler) => {
    onApplied = handler
    return unlisten
  })
})

afterEach(() => {
  controller?.dispose()
  controller = null
})

describe('createAssetDescribeController', () => {
  it('runs no launch pass — existing assets are never auto-scanned', async () => {
    create().start()
    await flush()
    expect(reconcileAssetDescriptions).not.toHaveBeenCalled()
  })

  it('describes a newly observed eligible asset, pinned to the generation', async () => {
    create().start()
    await flush()
    emitApplied([upsert('assets/a.png')])
    await flush()

    expect(reconcileAssetDescriptions).toHaveBeenCalledTimes(1)
    expect(reconcileAssetDescriptions).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'incremental',
        changed: ['assets/a.png'],
        providers: PROVIDERS,
        generation: 3,
      }),
    )
  })

  it('re-indexes the notes referencing assets it described, so the text is searchable', async () => {
    reconcileAssetDescriptions.mockResolvedValueOnce(
      outcome({ describedAssetPaths: ['assets/a.png'] }),
    )
    create().start()
    await flush()
    emitApplied([upsert('assets/a.png')])
    await flush()

    expect(reindexNotesReferencing).toHaveBeenCalledWith(['assets/a.png'], 3)
    // The re-index wrote search rows directly, so the caches must be invalidated
    // for ⌘K to reflect the new descriptions.
    expect(invalidateIndexQueries).toHaveBeenCalled()
  })

  it('does not re-index when nothing was described this pass', async () => {
    reconcileAssetDescriptions.mockResolvedValueOnce(outcome({ described: 0, describedAssetPaths: [] }))
    create().start()
    await flush()
    emitApplied([upsert('assets/a.png')])
    await flush()

    expect(reindexNotesReferencing).not.toHaveBeenCalled()
  })

  it('ignores descriptions, ineligible types, removes, and notes with no asset refs', async () => {
    create().start()
    await flush()
    emitApplied([
      upsert('assets/a.png.reflect.md'),
      upsert('assets/notes.txt'),
      { path: 'assets/a.png', kind: 'remove' },
      upsert('notes/x.md'), // readNote default returns a note with no asset refs
    ])
    await flush()

    expect(reconcileAssetDescriptions).not.toHaveBeenCalled()
  })

  it('re-evaluates assets referenced by a changed note (an asset newly made public)', async () => {
    readNote.mockResolvedValue('# Now public\n\n![](assets/a.png)\n')
    create().start()
    await flush()
    emitApplied([upsert('notes/x.md')])
    await flush()

    expect(readNote).toHaveBeenCalledWith('notes/x.md', 3)
    expect(reconcileAssetDescriptions).toHaveBeenCalledTimes(1)
    expect(reconcileAssetDescriptions.mock.calls[0]![0].changed).toEqual(['assets/a.png'])
  })

  it('coalesces a trigger that lands mid-pass into one follow-up', async () => {
    const first = deferred<ReconcileAssetDescriptionsOutcome>()
    reconcileAssetDescriptions.mockReturnValueOnce(first.promise)
    create().start()
    await flush()

    emitApplied([upsert('assets/a.png')]) // starts the pass (now in-flight)
    await flush()
    emitApplied([upsert('assets/b.pdf')]) // lands mid-pass → queued
    await flush()
    expect(reconcileAssetDescriptions).toHaveBeenCalledTimes(1)

    first.resolve(outcome()) // clears a.png; the follow-up runs for b.pdf
    await flush()

    expect(reconcileAssetDescriptions).toHaveBeenCalledTimes(2)
    expect(reconcileAssetDescriptions.mock.calls[0]![0].changed).toEqual(['assets/a.png'])
    expect(reconcileAssetDescriptions.mock.calls[1]![0].changed).toEqual(['assets/b.pdf'])
  })

  it('keeps an asset dirty after a transient stop and retries it on focus', async () => {
    reconcileAssetDescriptions.mockResolvedValueOnce(
      outcome({ described: 0, stopped: { reason: 'network', message: 'offline' } }),
    )
    create().start()
    await flush()

    emitApplied([upsert('assets/a.png')])
    await flush()
    expect(reconcileAssetDescriptions).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('focus')) // back online → retry the leftover
    await flush()

    expect(reconcileAssetDescriptions).toHaveBeenCalledTimes(2)
    expect(reconcileAssetDescriptions.mock.calls[1]![0].changed).toEqual(['assets/a.png'])
  })

  it('does not retry an asset a clean pass already handled', async () => {
    create().start()
    await flush()

    emitApplied([upsert('assets/a.png')])
    await flush()
    window.dispatchEvent(new Event('focus'))
    await flush()

    expect(reconcileAssetDescriptions).toHaveBeenCalledTimes(1)
  })

  it('dispose unlistens and stops further passes', async () => {
    const handle = create()
    handle.start()
    await flush()
    handle.dispose()

    expect(unlisten).toHaveBeenCalledTimes(1)
    emitApplied([upsert('assets/a.png')])
    await flush()
    expect(reconcileAssetDescriptions).not.toHaveBeenCalled()
  })

  it('start is idempotent — repeated calls do not duplicate subscriptions or passes', async () => {
    const handle = create()
    handle.start()
    handle.start() // second call must be a no-op
    await flush()

    expect(subscribeIndexApplied).toHaveBeenCalledTimes(1)
    emitApplied([upsert('assets/a.png')])
    await flush()
    expect(reconcileAssetDescriptions).toHaveBeenCalledTimes(1) // one pass, not two
  })

  it('ignores a post-apply batch from a different graph generation', async () => {
    create().start()
    await flush()

    onApplied?.([upsert('assets/a.png')], GEN + 1) // a stale emit from another graph
    await flush()
    expect(reconcileAssetDescriptions).not.toHaveBeenCalled()

    emitApplied([upsert('assets/a.png')]) // our generation → processed
    await flush()
    expect(reconcileAssetDescriptions).toHaveBeenCalledTimes(1)
  })
})
