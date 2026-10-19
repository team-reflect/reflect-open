import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors.ts'
import { createGraphSession, type GraphRole, type GraphSession } from '../graph/graph-session.ts'
import type { AppPlatform } from '../ports/platform-facts.ts'
import { createTestXArchiveService } from '../testing/capture.ts'
import { createTestClockService } from '../testing/clock.ts'
import { createNodeTestDatabaseService, seedNotes, type TestNote } from '../testing/database.ts'
import { createTestFileChangeService } from '../testing/file-change.ts'
import { createTestNoteFileService } from '../testing/graph.ts'
import { createTestIndexLifecycleService } from '../testing/index-lifecycle.ts'
import {
  createTestIndexStoreService,
  type IndexStoreCall,
  type TestIndexStoreServiceOptions,
} from '../testing/index-store.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { createTestPlatformService } from '../testing/platform.ts'
import { createTestProgressPort } from '../testing/ports.ts'
import { createTestActivityPort } from '../testing/shell.ts'
import {
  createIndexLifecycleService,
  type IndexAppliedEvent,
  type IndexLifecycleProgress,
  type IndexReconciledEvent,
} from './index-lifecycle-service.ts'
import { createIndexQueryService } from './index-query-service.ts'
import { PROJECTION_VERSION } from './indexed-note.ts'
import { PROJECTION_VERSION_KEY } from './indexer.ts'

const databases: { close(): void }[] = []

/**
 * The file generation of every test session; the note file double rejects reads at any other.
 */
const FILE_GENERATION = 1

/**
 * A graph session at index generation `indexGeneration` that ends when `signal` aborts.
 */
function sessionAt(indexGeneration: number, signal?: AbortSignal): GraphSession {
  return createGraphSession(
    { root: '/g', name: 'g', generation: FILE_GENERATION, indexGeneration },
    signal,
  )
}

/**
 * A graph session at index generation `indexGeneration` that already ended.
 */
function endedSessionAt(indexGeneration: number): GraphSession {
  return sessionAt(indexGeneration, AbortSignal.abort())
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

/**
 * A lifecycle over test doubles, with every event recorded. The index is
 * stamped with the current projection version, so a sync pass is one
 * reconcile scan (`scan` in `steps`). The hooks run inside the matching call
 * of the pass: `onScan` may hold or reject the reconcile, `onSubscribe` runs
 * as the live subscription attaches, `onWatchStart` as the watcher starts.
 */
function setup(options?: {
  files?: Readonly<Record<string, string>>
  indexed?: readonly TestNote[]
  store?: TestIndexStoreServiceOptions
  failStore?: (call: IndexStoreCall) => Error | undefined
  onScan?: () => Promise<void>
  onClear?: () => Promise<void>
  onSubscribe?: () => void
  onWatchStart?: () => void
  onRead?: () => void
  appPlatform?: AppPlatform
  role?: GraphRole
  hidden?: boolean
}) {
  const database = createNodeTestDatabaseService()
  databases.push(database)
  seedNotes(database, options?.indexed ?? [])
  const steps: string[] = []
  const store = createTestIndexStoreService({
    meta: { [PROJECTION_VERSION_KEY]: String(PROJECTION_VERSION) },
    ...options?.store,
    ...(options?.failStore ? { fail: options.failStore } : {}),
  })
  const files = createTestNoteFileService({
    files: options?.files ?? {},
    generation: FILE_GENERATION,
  })
  const fileChanges = createTestFileChangeService()
  const logger = createTestLoggerService()
  const clock = createTestClockService()
  const operations = createTestProgressPort()
  const graph: { session: GraphSession | null } = { session: sessionAt(7) }
  const graphListeners = new Set<() => void>()
  const activity = createTestActivityPort({ hidden: options?.hidden ?? false })
  const reconcileScan = store.reconcileScan.bind(store)
  vi.spyOn(store, 'reconcileScan').mockImplementation(async (generation) => {
    steps.push('scan')
    await options?.onScan?.()
    return await reconcileScan(generation)
  })
  const clear = store.clear.bind(store)
  vi.spyOn(store, 'clear').mockImplementation(async (generation) => {
    steps.push('clear')
    await options?.onClear?.()
    await clear(generation)
  })
  const subscribe = fileChanges.subscribe.bind(fileChanges)
  vi.spyOn(fileChanges, 'subscribe').mockImplementation((listener) => {
    steps.push('subscribe')
    const unlisten = subscribe(listener)
    options?.onSubscribe?.()
    return unlisten
  })
  const startWatcher = fileChanges.startWatcher.bind(fileChanges)
  vi.spyOn(fileChanges, 'startWatcher').mockImplementation(async () => {
    steps.push('watchStart')
    options?.onWatchStart?.()
    await startWatcher()
  })
  const stopWatcher = fileChanges.stopWatcher.bind(fileChanges)
  vi.spyOn(fileChanges, 'stopWatcher').mockImplementation(async () => {
    steps.push('watchStop')
    await stopWatcher()
  })
  const readFile = files.read.bind(files)
  vi.spyOn(files, 'read').mockImplementation(async (path, generation) => {
    options?.onRead?.()
    return await readFile(path, generation)
  })
  const index = createIndexLifecycleService({
    indexStore: store,
    noteFile: files,
    fileChanges,
    indexQuery: createIndexQueryService({ database }),
    database,
    xArchive: createTestXArchiveService(),
    clock,
    logger,
    progress: operations,
    graphSession: {
      getState: () => graph,
      subscribe: (listener) => {
        graphListeners.add(listener)
        return () => {
          graphListeners.delete(listener)
        }
      },
    },
    activity,
    platform: createTestPlatformService({ appPlatform: options?.appPlatform ?? 'desktop' }),
    role: options?.role ?? 'main',
  })
  const progress: IndexLifecycleProgress[] = []
  const applied: IndexAppliedEvent[] = []
  const reconciled: IndexReconciledEvent[] = []
  const moved: Array<[string, string]> = []
  const fileProgress: Array<[number, number, number]> = []
  const stalePlaceholders: string[][] = []
  const order: string[] = []
  index.onProgress((stage) => {
    progress.push(stage)
  })
  index.onApplied((event) => {
    applied.push(event)
    order.push('applied')
  })
  index.onReconciled((event) => {
    reconciled.push(event)
    order.push('reconciled')
  })
  index.onMoved((from, to) => {
    moved.push([from, to])
  })
  index.onFileProgress((done, total, worked) => {
    fileProgress.push([done, total, worked])
  })
  index.onStalePlaceholders((paths) => {
    stalePlaceholders.push([...paths])
  })
  return {
    index,
    graph,
    activity,
    /**
     * Publish `session` as the open graph's session, as a graph open does.
     */
    openSession: (session: GraphSession | null) => {
      graph.session = session
      for (const listener of graphListeners) {
        listener()
      }
    },
    store,
    files,
    fileChanges,
    logger,
    operations,
    steps,
    progress,
    applied,
    reconciled,
    moved,
    fileProgress,
    stalePlaceholders,
    order,
    /**
     * How many sync passes reached their reconcile.
     */
    passes: () => steps.filter((step) => step === 'scan').length,
    /**
     * Live subscriptions currently attached to the change stream.
     */
    subscriptions: () => fileChanges.listenerCount().changes,
  }
}

/**
 * Sync passes that each stay in flight until their entry in `settles` is called.
 */
function heldScans() {
  const settles: Array<() => void> = []
  return {
    settles,
    onScan: () =>
      new Promise<void>((resolve) => {
        settles.push(resolve)
      }),
  }
}

describe('createIndexLifecycleService', () => {
  it('open() returns the generation from the index store', async () => {
    const { index } = setup({ store: { generation: 3 } })
    expect(await index.open()).toBe(3)
  })

  it('open() returns null and logs the failure (editing is never blocked)', async () => {
    const { index, logger } = setup({
      failStore: (call) => (call.method === 'open' ? new Error('boom') : undefined),
    })
    expect(await index.open()).toBeNull()
    expect(logger.getErrors()).toEqual([{ message: 'index open failed:', cause: 'boom' }])
  })

  it('close() stops the watcher and does not reconcile', async () => {
    const { index, steps } = setup()
    await index.close()
    expect(steps).toEqual(['watchStop'])
  })

  it('sync(session) reconciles, then subscribes, then starts the watcher', async () => {
    const { index, store, fileChanges, steps, applied, subscriptions } = setup()
    index.sync(sessionAt(5))
    await index.settled() // settle without aborting: `stop()` skips the tail

    expect(store.calls()).toContainEqual({ method: 'reconcileScan', generation: 5 })
    // Sequenced: reconcile → subscribe → watchStart.
    expect(steps).toEqual(['scan', 'subscribe', 'watchStart'])
    // The initial reconcile is itself an index change: invalidate once there.
    expect(applied).toEqual([{ generation: 5, changes: null }])
    expect(fileChanges.watcherRunning()).toBe(true)
    expect(subscriptions()).toBe(1) // retained as the active subscription
  })

  it('reports the full batch of each applied watcher batch, asset files included', async () => {
    const { index, fileChanges } = setup({ files: { 'notes/a.md': '# A' } })
    const batches: IndexAppliedEvent[] = []
    const unlisten = index.onApplied((event) => {
      batches.push(event)
    })
    index.sync(sessionAt(5))
    await index.settled()
    expect(batches).toEqual([{ generation: 5, changes: null }]) // a sync pass reports no batch

    const changes = [
      { path: 'notes/a.md', kind: 'upsert' as const },
      { path: 'notes/gone.md', kind: 'remove' as const },
      { path: 'assets/photo.png', kind: 'upsert' as const },
    ]
    fileChanges.emit({ changes, source: 'external' })
    await vi.waitFor(() => expect(batches).toHaveLength(2))
    expect(batches[1]).toEqual({ generation: 5, changes })

    unlisten()
    fileChanges.emit({ changes, source: 'external' })
    await index.close()
    expect(batches).toHaveLength(2)
  })

  it('reports the notes a description re-index applied, to its own listeners only', async () => {
    const REFERENCING = '# Hello\n\n![pic](assets/pic.png)\n'
    const { index } = setup({
      files: { 'notes/a.md': REFERENCING },
      indexed: [{ path: 'notes/a.md', markdown: REFERENCING }],
    })
    const other = setup()
    const batches: IndexAppliedEvent[] = []
    const otherBatches: IndexAppliedEvent[] = []
    index.onApplied((event) => {
      batches.push(event)
    })
    other.index.onApplied((event) => {
      otherBatches.push(event)
    })

    await index.reindexNotesReferencing(['assets/pic.png'], {
      generation: 7,
      fileGeneration: FILE_GENERATION,
    })

    expect(batches).toEqual([{ generation: 7, changes: [{ path: 'notes/a.md', kind: 'upsert' }] }])
    expect(otherBatches).toEqual([]) // the signal is per lifecycle, not process-wide
  })

  it('reports a move healed by the reconcile', async () => {
    const OLD = 'notes/01arz3ndektsv4rrffq69g5fav.md'
    const NEW = 'notes/meeting-notes.md'
    const content = '---\nid: 01abcdefghjkmnpqrstvwxyz00\n---\n# Meeting Notes\n'
    const { index, moved } = setup({
      files: { [NEW]: content },
      indexed: [{ path: OLD, markdown: content }],
      store: {
        scan: {
          total: 1,
          candidates: [{ path: NEW, modifiedMs: 9, storedMtime: null, storedHash: null }],
          orphans: [{ path: OLD, storedMtime: 1, storedHash: 'stored' }],
          stalePlaceholders: [],
        },
      },
    })
    index.sync(sessionAt(5))
    await index.settled()
    expect(moved).toEqual([[OLD, NEW]])
  })

  it('reports a completed pass via onReconciled, after onApplied', async () => {
    // The pass reads changed files into the index without emitting per-file
    // events; open note sessions re-read off this event.
    const { index, order, reconciled } = setup()
    index.sync(sessionAt(5))
    await index.settled() // settle without aborting: `stop()` would suppress it
    expect(order).toEqual(['applied', 'reconciled'])
    expect(reconciled).toEqual([{ generation: 5, fileGeneration: FILE_GENERATION, source: 'sync' }])
  })

  it('logs a completed pass with its read counters', async () => {
    const { index, logger } = setup()
    index.sync(sessionAt(5))
    await index.settled()
    expect(logger.getInfos().map((entry) => entry.message)).toEqual([
      'index: pass finished in 0ms — read 0 of 0 files',
    ])
  })

  it('a superseded or failed pass never fires onReconciled', async () => {
    let fail = false
    const { index, reconciled } = setup({
      failStore: (call) =>
        fail && call.method === 'reconcileScan' ? new Error('boom') : undefined,
    })
    index.sync(endedSessionAt(5)) // stale right after the reconcile
    await index.settled()
    expect(reconciled).toEqual([])

    fail = true
    index.sync(sessionAt(5))
    await index.settled()
    expect(reconciled).toEqual([])
  })

  it('an aborted pass runs no tail: no events, no subscribe, no watcher', async () => {
    // `stop()` aborts without ending the session, so an interrupted pass
    // bails on its own signal. Whoever stopped it either starts a replacement
    // pass (`refresh`, a graph switch) or tears the lifecycle down (`close`),
    // so a tail here is only undone and redone moments later.
    const { index, steps, applied, reconciled, logger } = setup()
    index.sync(sessionAt(5))
    await index.stop()
    expect(applied).toEqual([])
    expect(reconciled).toEqual([])
    expect(steps).not.toContain('subscribe')
    expect(steps).not.toContain('watchStart')
    expect(logger.getInfos()).toEqual([])
  })

  it('reports progress: reconciling → live; idle when closed', async () => {
    const { index, progress } = setup()
    index.sync(sessionAt(5))
    await index.settled()
    expect(progress).toEqual(['reconciling', 'live'])

    await index.close()
    expect(progress).toEqual(['reconciling', 'live', 'idle'])
  })

  it('reports idle (not live) when the sync pass fails un-superseded', async () => {
    const { index, progress } = setup({
      failStore: (call) => (call.method === 'reconcileScan' ? new Error('boom') : undefined),
    })
    index.sync(sessionAt(5))
    await index.stop()
    expect(progress).toEqual(['reconciling', 'idle'])
  })

  it('bails after reconcile when superseded — no subscribe, no watcher', async () => {
    const { index, steps } = setup()
    index.sync(endedSessionAt(5)) // stale immediately after reconcile
    await index.settled()
    expect(steps).toEqual(['scan'])
  })

  it('tears down a subscription created after supersession (no listener leak)', async () => {
    const opened = new AbortController()
    // Fresh through the reconcile, stale by the time the subscription exists.
    const { index, steps, subscriptions } = setup({
      onSubscribe: () => {
        opened.abort()
      },
    })
    index.sync(sessionAt(5, opened.signal))
    await index.settled()
    expect(steps).toEqual(['scan', 'subscribe'])
    expect(subscriptions()).toBe(0) // pending subscription cleaned up
  })

  it('an abort during the subscribe drops the pending subscription', async () => {
    const harness = setup({
      onSubscribe: () => {
        void harness.index.stop()
      },
    })
    harness.index.sync(sessionAt(5))
    await harness.index.settled()
    expect(harness.steps).toEqual(['scan', 'subscribe'])
    expect(harness.subscriptions()).toBe(0) // pending subscription cleaned up
  })

  it('an abort during the watcher start leaves the subscription unadopted', async () => {
    const harness = setup({
      onWatchStart: () => {
        void harness.index.stop()
      },
    })
    harness.index.sync(sessionAt(5))
    await harness.index.settled()
    // Dropped rather than adopted, and the pass never claims to be live. The
    // watcher stays up for the replacement pass; only `close` stops it.
    expect(harness.subscriptions()).toBe(0)
    expect(harness.fileChanges.watcherRunning()).toBe(true)
    expect(harness.progress).toEqual(['reconciling'])
  })

  it('logs a sync failure but stop() still settles', async () => {
    const { index, logger } = setup({
      failStore: (call) =>
        call.method === 'reconcileScan' ? new Error('reconcile boom') : undefined,
    })
    index.sync(sessionAt(5))
    await index.stop()
    expect(logger.getErrors()).toEqual([{ message: 'index sync failed:', cause: 'reconcile boom' }])
  })

  it('stop() aborts the running reconcile and waits for it to settle', async () => {
    const held = heldScans()
    const { index, steps } = setup({ onScan: held.onScan })
    index.sync(sessionAt(5))
    await vi.waitFor(() => expect(held.settles).toHaveLength(1))

    let stopped = false
    const stopping = index.stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false) // still waiting on the pass

    held.settles[0]!()
    await stopping
    // Aborted before the reconcile returned: the pass wrote nothing further.
    expect(steps).toEqual(['scan'])
  })

  it('stop() before any sync resolves immediately', async () => {
    await expect(setup().index.stop()).resolves.toBeUndefined()
  })

  it('close() drops an active subscription', async () => {
    const { index, fileChanges, subscriptions } = setup()
    index.sync(sessionAt(5))
    await index.settled()
    expect(subscriptions()).toBe(1)

    await index.close()

    expect(subscriptions()).toBe(0)
    expect(fileChanges.watcherRunning()).toBe(false)
  })

  it('sync() drops the previous live subscription before the next pass', async () => {
    const { index, subscriptions } = setup()
    index.sync(sessionAt(5))
    await index.settled()

    index.sync(endedSessionAt(6))
    expect(subscriptions()).toBe(0)
    await index.settled()
  })

  it('refresh() coalesces stacked triggers into a single queued rerun', async () => {
    // Resume, poll-end, and watch-failed can fire together; each used to
    // abort the in-flight pass and start another — a full pass per trigger.
    const held = heldScans()
    const { index, passes } = setup({ onScan: held.onScan })

    index.refresh(sessionAt(5))
    await vi.waitFor(() => expect(held.settles).toHaveLength(1))
    index.refresh(sessionAt(5))
    index.refresh(sessionAt(5))
    index.refresh(sessionAt(5))

    held.settles[0]!()
    // The three stacked triggers fold into exactly one rerun…
    await vi.waitFor(() => expect(held.settles).toHaveLength(2))
    held.settles[1]!()
    // …and nothing further runs once the queue drains.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(passes()).toBe(2)
  })

  it('refresh() bails without a rerun when superseded', async () => {
    const { index, passes } = setup()
    index.refresh(endedSessionAt(5)) // a newer open owns the lifecycle
    await index.settled()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(passes()).toBe(0)
  })

  it('defers an initial sync while the suspend guard holds and replays it on resume', async () => {
    let backgrounded = true
    const { index, steps, passes } = setup()
    index.setSuspendGuard(() => backgrounded)

    index.sync(sessionAt(5))
    await Promise.resolve()
    expect(steps).toEqual([])

    backgrounded = false
    index.resume(sessionAt(5))
    await vi.waitFor(() => expect(passes()).toBe(1))
    await index.settled()

    expect(steps).toEqual(['scan', 'subscribe', 'watchStart'])
  })

  it('resume(null) clears suspension without starting work before graph open', async () => {
    const { index, steps, passes } = setup()
    index.suspend()

    index.resume(null)
    await Promise.resolve()
    expect(passes()).toBe(0)

    index.sync(sessionAt(5))
    await index.settled()
    expect(steps).toEqual(['scan', 'subscribe', 'watchStart'])
  })

  it('suspend() aborts bulk work, drops live work, and resume coalesces catch-up triggers', async () => {
    const settles: Array<() => void> = []
    let hold = false
    const { index, store, files, fileChanges, passes, subscriptions, progress } = setup({
      files: { 'notes/a.md': '# A' },
      onScan: async () => {
        if (hold) {
          await new Promise<void>((resolve) => {
            settles.push(resolve)
          })
        }
      },
    })
    index.sync(sessionAt(5))
    await index.settled()
    expect(subscriptions()).toBe(1)

    index.suspend()
    expect(subscriptions()).toBe(0)
    expect(progress.at(-1)).toBe('idle')
    // A batch that arrives while suspended is not applied.
    files.set('notes/a.md', '# A, edited')
    fileChanges.emit({ changes: [{ path: 'notes/a.md', kind: 'upsert' }], source: 'external' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.applied()).toEqual([])

    hold = true
    index.resume(sessionAt(5))
    await vi.waitFor(() => expect(settles).toHaveLength(1))
    index.refresh(sessionAt(5))
    index.refresh(sessionAt(5))

    settles[0]!()
    await vi.waitFor(() => expect(settles).toHaveLength(2))
    settles[1]!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // One foreground catch-up plus one coalesced queued rerun, not one pass
    // for every simultaneous resume/iCloud trigger.
    expect(passes()).toBe(3)
  })

  it('reports stale placeholders of the running pass only', async () => {
    const scan = {
      total: 1,
      candidates: [],
      orphans: [],
      stalePlaceholders: ['notes/evicted.md'],
    }
    const current = setup({ store: { scan } })
    current.index.sync(sessionAt(5))
    await current.index.settled()
    expect(current.stalePlaceholders).toEqual([['notes/evicted.md']])

    // Opening a graph swaps the root before the old pass is stopped: a
    // superseded pass must not request its old paths against the new graph.
    const superseded = setup({ store: { scan } })
    superseded.index.sync(endedSessionAt(5))
    await superseded.index.settled()
    expect(superseded.stalePlaceholders).toEqual([])
  })
})

describe('file progress', () => {
  /**
   * 32 changed candidates: the reconcile reports at file 16 and at the end.
   */
  function setupLargePass(onRead?: () => void) {
    const paths = Array.from({ length: 32 }, (_, position) => `notes/n${position}.md`)
    return setup({
      files: Object.fromEntries(paths.map((path) => [path, `# ${path}`])),
      ...(onRead ? { onRead } : {}),
      store: {
        scan: {
          total: 32,
          candidates: paths.map((path) => ({
            path,
            modifiedMs: 2_000,
            storedMtime: 1_000,
            storedHash: 'old',
          })),
          orphans: [],
          stalePlaceholders: [],
        },
      },
    })
  }

  it('publishes the running pass and clears once it goes live', async () => {
    const { index, fileProgress } = setupLargePass()
    const seen: Array<ReturnType<typeof index.fileProgress>> = []
    const unsubscribe = index.subscribeFileProgress(() => {
      seen.push(index.fileProgress())
    })
    expect(index.fileProgress()).toBeNull()

    index.sync(sessionAt(5))
    await index.settled()

    expect(fileProgress).toEqual([
      [16, 32, 15],
      [32, 32, 31],
      [32, 32, 32],
    ])
    expect(seen).toEqual([
      { done: 16, total: 32, worked: 15 },
      { done: 32, total: 32, worked: 31 },
      { done: 32, total: 32, worked: 32 },
      null, // the pass went live: the pill clears
    ])

    unsubscribe()
    index.suspend()
    expect(seen).toHaveLength(4) // already clear, and no longer listening
  })

  it('stops reporting file progress once the pass is superseded', async () => {
    let reads = 0
    const opened = new AbortController()
    const { index, fileProgress } = setupLargePass(() => {
      reads += 1
      if (reads === 20) {
        opened.abort() // a superseded pass must go quiet
      }
    })
    index.sync(sessionAt(5, opened.signal))
    await index.settled()

    expect(fileProgress).toEqual([[16, 32, 15]])
  })

  it('a test lifecycle seeds file progress for its subscribers', () => {
    const index = createTestIndexLifecycleService()
    const listener = vi.fn()
    const unsubscribe = index.subscribeFileProgress(listener)

    index.setFileProgress({ done: 16, total: 3000, worked: 16 })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(index.fileProgress()).toEqual({ done: 16, total: 3000, worked: 16 })

    index.setFileProgress(null)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(index.fileProgress()).toBeNull()

    unsubscribe()
    index.setFileProgress({ done: 1, total: 200, worked: 1 })
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('rebuildVisibly', () => {
  function heldClears() {
    const settles: Array<() => void> = []
    return {
      settles,
      onClear: () =>
        new Promise<void>((resolve) => {
          settles.push(resolve)
        }),
    }
  }

  function clears(steps: readonly string[]): number {
    return steps.filter((step) => step === 'clear').length
  }

  it('rebuilds at the open index generation and reports as an operation', async () => {
    const { index, store, operations, reconciled } = setup({ files: { 'notes/a.md': '# A' } })

    await index.rebuildVisibly()

    expect(store.calls().map((call) => call.method)).toEqual(['clear', 'applyBatch', 'setMeta'])
    expect(store.calls()[0]).toEqual({ method: 'clear', generation: 7 })
    expect(operations.started()).toMatchObject([{ label: 'Rebuilding search index', ended: true }])
    expect(reconciled).toEqual([
      { generation: 7, fileGeneration: FILE_GENERATION, source: 'rebuild' },
    ])
  })

  it('coalesces concurrent requests at the same generation onto one pass', async () => {
    const held = heldClears()
    const { index, steps } = setup({ onClear: held.onClear })

    const first = index.rebuildVisibly()
    const second = index.rebuildVisibly()

    expect(second).toBe(first)
    expect(clears(steps)).toBe(1)

    held.settles[0]!()
    await first

    // Once settled, the guard is released and the next request rebuilds again.
    const third = index.rebuildVisibly()
    await vi.waitFor(() => expect(held.settles).toHaveLength(2))
    held.settles[1]!()
    await third
    expect(clears(steps)).toBe(2)
  })

  it('does nothing without an open index', async () => {
    const { index, graph, store, operations } = setup()

    graph.session = null
    await index.rebuildVisibly()
    graph.session = createGraphSession({
      root: '/g',
      name: 'g',
      generation: 1,
      indexGeneration: null,
    })
    await index.rebuildVisibly()

    expect(store.calls()).toEqual([])
    expect(operations.snapshot()).toEqual([])
  })

  it('starts a fresh pass for a different generation', async () => {
    const held = heldClears()
    const { index, graph, store, steps } = setup({ onClear: held.onClear })

    const first = index.rebuildVisibly()
    graph.session = sessionAt(8)
    const second = index.rebuildVisibly()
    expect(second).not.toBe(first)
    await vi.waitFor(() => expect(held.settles).toHaveLength(2))

    expect(clears(steps)).toBe(2)
    held.settles[1]!()
    await second
    expect(store.calls()).toContainEqual({ method: 'clear', generation: 8 })

    held.settles[0]!()
    await first
  })

  it('stays in flight until the followers of the rebuild settle', async () => {
    const follower = Promise.withResolvers<void>()
    const { index, steps } = setup()
    index.onReconciled(async ({ source }) => {
      if (source === 'rebuild') {
        await follower.promise
      }
    })

    const first = index.rebuildVisibly()
    await vi.waitFor(() => expect(steps).toContain('clear'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The wipe and the re-index are done, the follower (a re-embed) is not:
    // a second request still joins the same pass.
    expect(index.rebuildVisibly()).toBe(first)

    follower.resolve()
    await first
    expect(clears(steps)).toBe(1)
  })

  it('warns with a sample when a rebuild reports skipped notes', async () => {
    const { index, operations, logger, reconciled } = setup({
      files: { 'notes/bad.md': '# bad' },
      failStore: (call) =>
        call.method === 'applyBatch'
          ? new AppError('parse', 'unexpected end of hex escape')
          : undefined,
    })

    await expect(index.rebuildVisibly()).resolves.toBeUndefined()

    expect(logger.getWarnings().map((entry) => entry.message)).toEqual([
      'Index rebuild skipped notes/bad.md: unexpected end of hex escape',
    ])
    expect(operations.snapshot()).toMatchObject([
      {
        label: 'Rebuilding search index',
        status: 'warning',
        message: 'Rebuilt with 1 skipped note(s): notes/bad.md: unexpected end of hex escape',
      },
    ])
    expect(reconciled).toEqual([
      { generation: 7, fileGeneration: FILE_GENERATION, source: 'rebuild' },
    ])
  })

  it('absorbs a failed rebuild, reports nothing, and releases the in-flight guard', async () => {
    let fail = true
    const { index, operations, reconciled, steps } = setup({
      failStore: (call) =>
        fail && call.method === 'clear' ? new Error('index on fire') : undefined,
    })

    await expect(index.rebuildVisibly()).resolves.toBeUndefined()
    expect(operations.snapshot()).toMatchObject([{ status: 'failed', message: 'index on fire' }])
    expect(reconciled).toEqual([])

    fail = false
    await index.rebuildVisibly()
    expect(clears(steps)).toBe(2)
    expect(reconciled).toEqual([
      { generation: 7, fileGeneration: FILE_GENERATION, source: 'rebuild' },
    ])
  })

  it('a test lifecycle records the requested generations', async () => {
    const session = sessionAt(7)
    const index = createTestIndexLifecycleService({
      graphSession: { getState: () => ({ session }), subscribe: () => () => {} },
    })
    await index.rebuildVisibly()
    expect(index.rebuilds()).toEqual([7])
  })
})

describe('applyChanges', () => {
  it('applies the changed notes without a live subscription and reports them', async () => {
    const { index, store, applied, steps } = setup({
      files: { 'notes/pulled.md': '# Pulled\n' },
    })

    const mutations = await index.applyChanges(
      [
        { path: 'notes/pulled.md', kind: 'upsert', modifiedMs: 5 },
        { path: 'audio-memos/memo.m4a', kind: 'upsert', modifiedMs: 6 },
      ],
      4,
      FILE_GENERATION,
    )

    expect(mutations).toBe(1)
    expect(store.applied().map((note) => note.path)).toEqual(['notes/pulled.md'])
    expect(applied).toEqual([
      { generation: 4, changes: [{ path: 'notes/pulled.md', kind: 'upsert', modifiedMs: 5 }] },
    ])
    expect(steps).not.toContain('subscribe')
  })

  it('reports nothing when no index row changed', async () => {
    const { index, applied } = setup()

    expect(
      await index.applyChanges([{ path: 'assets/a.png', kind: 'upsert' }], 4, FILE_GENERATION),
    ).toBe(0)
    expect(applied).toEqual([])
  })

  it('writes nothing while `canApply` says no', async () => {
    const { index, store, applied } = setup({ files: { 'notes/pulled.md': '# Pulled\n' } })

    const mutations = await index.applyChanges(
      [{ path: 'notes/pulled.md', kind: 'upsert', modifiedMs: 5 }],
      4,
      FILE_GENERATION,
      () => false,
    )

    expect(mutations).toBe(0)
    expect(store.applied()).toEqual([])
    expect(applied).toEqual([])
  })
})

describe('followActivity', () => {
  /**
   * Wait until every pass the lifecycle started has settled.
   */
  async function settle(index: { settled: () => Promise<void> }): Promise<void> {
    await Promise.resolve()
    await index.settled()
  }

  it('defers the first index pass while hidden and replays it on foreground', async () => {
    const context = setup({ appPlatform: 'ios', hidden: true })
    context.openSession(null)
    context.index.followActivity()

    const session = sessionAt(7)
    context.openSession(session)
    context.index.sync(session)
    await settle(context.index)
    expect(context.passes()).toBe(0)

    // Resume performs a full sync, which catches files and local events the
    // intentionally absent live subscription could not observe while hidden.
    context.activity.emitVisible()
    await expect.poll(() => context.passes()).toBe(1)
  })

  it('clears suspension when the app foregrounds before its index session opens', async () => {
    const context = setup({ appPlatform: 'ios', hidden: true })
    context.openSession(null)
    context.index.followActivity()

    // The app foregrounds while onboarding still has no graph/index. This
    // must clear the sticky suspension even though there is nothing to sync.
    context.activity.emitVisible()
    await settle(context.index)
    expect(context.passes()).toBe(0)

    const session = sessionAt(7)
    context.openSession(session)
    context.index.sync(session)
    await expect.poll(() => context.passes()).toBe(1)
  })

  it('suspends the live index when the app hides', async () => {
    const context = setup({ appPlatform: 'ios' })
    context.index.followActivity()
    const session = sessionAt(7)
    context.index.sync(session)
    await expect.poll(() => context.subscriptions()).toBe(1)

    context.activity.emitHidden()

    expect(context.subscriptions()).toBe(0)
    context.index.refresh(session)
    await settle(context.index)
    expect(context.passes()).toBe(1)
  })

  it.each([
    { appPlatform: 'desktop', role: 'main' },
    { appPlatform: 'ios', role: 'note-window' },
  ] as const)('never suspends on $appPlatform in the $role window', async (options) => {
    const context = setup({ ...options, hidden: true })
    context.index.followActivity()
    context.index.sync(sessionAt(7))
    await expect.poll(() => context.passes()).toBe(1)
    context.activity.emitHidden()
    await settle(context.index)
    expect(context.subscriptions()).toBe(1)
  })

  it('removes the suspend guard once stopped', async () => {
    const context = setup({ appPlatform: 'ios' })
    const stop = context.index.followActivity()
    stop()
    context.activity.setHidden(true)

    context.index.sync(sessionAt(7))
    await settle(context.index)
    expect(context.passes()).toBe(1)
  })
})
