import { describe, expect, it, vi } from 'vitest'
import { createGraphSession, type GraphRole } from '../graph/graph-session.ts'
import {
  TEST_EMBED_MODEL,
  createTestActivityPort,
  createTestDatabaseService,
  createTestEmbeddingIndexService,
  createTestEmbeddingRuntimeService,
  createTestGraphSessionService,
  createTestIndexLifecycleService,
  createTestIndexStoreService,
  createTestLoggerService,
  createTestNetworkService,
  createTestNoteFileService,
  createTestProgressPort,
  createTestRetrievalService,
  createTestScreenService,
  createTestSemanticSearchService,
  createTestSettingsService,
  createTestStorageService,
  seedNotes,
} from '../testing/index.ts'
import { WritableStore } from '../store.ts'
import type { EmbeddingBackfillResult } from './embedding-index-service.ts'
import type { EmbedStatus } from './embedding-runtime-service.ts'
import type { RetrievalHit } from './retrieval-service.ts'
import { sleep } from '@ocavue/utils'

const READY: EmbedStatus = { status: 'ready', model: TEST_EMBED_MODEL }
const GRAPH = { root: '/g', name: 'g', generation: 1 }

/**
 * A semantic search over fakes, with the graph `/g` open at index generation 7.
 */
async function setup(options?: {
  enabled?: boolean
  status?: EmbedStatus
  legacyOptIn?: string
  role?: GraphRole
  failClear?: boolean
  backfill?: () => Promise<EmbeddingBackfillResult>
  relatedNotes?: (path: string, limit?: number) => RetrievalHit[]
  unloadWhenHidden?: boolean
  /**
   * Whether the connection is expensive, `null` while it is unknown.
   * Defaults to `false`.
   */
  expensive?: boolean | null
  /**
   * Whether the model file is on disk. Defaults to `true`.
   */
  downloaded?: boolean
  /**
   * Notes in the index and on disk for the embedding pass.
   */
  notes?: { path: string; markdown: string }[]
}) {
  const logger = createTestLoggerService()
  const progress = createTestProgressPort()
  const settings = createTestSettingsService({
    semanticSearchEnabled: options?.enabled ?? true,
  })
  await settings.whenLoaded()
  const storage = createTestStorageService(
    options?.legacyOptIn === undefined
      ? {}
      : { local: { 'reflect.semantic.enabled': options.legacyOptIn } },
  )
  const runtime = createTestEmbeddingRuntimeService({
    status: options?.status ?? READY,
    downloaded: options?.downloaded,
  })
  const network = createTestNetworkService(
    options?.expensive === undefined ? {} : { expensive: options.expensive },
  )
  const session = createGraphSession({ ...GRAPH, indexGeneration: 7 })
  const indexLifecycle = createTestIndexLifecycleService({
    logger,
    progress,
    graphSession: new WritableStore({ session }),
    indexStore: createTestIndexStoreService({
      fail: (call) => {
        return options?.failClear === true && call.method === 'clear'
          ? new Error('index on fire')
          : undefined
      },
    }),
  })
  const notes = options?.notes ?? []
  const database = createTestDatabaseService()
  seedNotes(database, notes)
  const embeddingIndex = createTestEmbeddingIndexService({
    embeddingRuntime: runtime,
    database,
    noteFile: createTestNoteFileService({
      files: Object.fromEntries(notes.map((note) => [note.path, note.markdown])),
    }),
    indexLifecycle,
    logger,
    backfill: options?.backfill,
  })
  const retrieval = createTestRetrievalService(
    options?.relatedNotes === undefined ? {} : { relatedNotes: options.relatedNotes },
  )
  const graphSession = createTestGraphSessionService({
    indexLifecycle,
    logger,
    state: { graph: GRAPH, indexGeneration: 7 },
  })
  const activity = createTestActivityPort()
  const screen = createTestScreenService()
  const semanticSearch = createTestSemanticSearchService({
    embeddingRuntime: runtime,
    embeddingIndex,
    retrieval,
    settings,
    storage,
    role: options?.role ?? 'main',
    indexLifecycle,
    graphSession,
    activity,
    network,
    screen,
    unloadWhenHidden: options?.unloadWhenHidden ?? false,
    logger,
  })
  return {
    semanticSearch,
    activity,
    network,
    screen,
    settings,
    storage,
    runtime,
    indexLifecycle,
    embeddingIndex,
    retrieval,
    graphSession,
    progress,
    logger,
  }
}

/**
 * One macrotask — long enough for a would-be reaction to have started.
 */
function flush(): Promise<void> {
  return sleep(0)
}

describe('start', () => {
  it('carries a stored legacy opt-in into the settings exactly once', async () => {
    const { semanticSearch, settings, storage } = await setup({
      enabled: false,
      legacyOptIn: 'true',
    })

    const stop = semanticSearch.start()
    expect(settings.get().semanticSearchEnabled).toBe(true)
    expect(storage.dump().local).toEqual({})
    stop()

    // The settings document owns the opt-in after: a later start changes nothing.
    settings.update({ semanticSearchEnabled: false })
    semanticSearch.start()()
    expect(settings.get().semanticSearchEnabled).toBe(false)
  })

  it('leaves the settings alone when the legacy key was never set', async () => {
    const { semanticSearch, settings } = await setup({ enabled: false })

    const stop = semanticSearch.start()
    await flush()

    expect(settings.get().semanticSearchEnabled).toBe(false)
    expect(settings.saves()).toEqual([])
    stop()
  })

  it('loads the model while enabled and untouched, then backfills and follows', async () => {
    const { semanticSearch, runtime, embeddingIndex } = await setup()

    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(embeddingIndex.follows()).toHaveLength(1))

    expect(runtime.ensureCalls()).toBe(1)
    expect(embeddingIndex.follows()).toEqual([{ generation: 7, modelId: TEST_EMBED_MODEL }])
    stop()
  })

  it('embeds the notes of applied index batches while enabled and ready', async () => {
    const { semanticSearch, embeddingIndex, indexLifecycle } = await setup()
    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(embeddingIndex.follows()).toHaveLength(1))

    indexLifecycle.emitApplied([{ kind: 'remove', path: 'notes/a.md' }], 7)

    await vi.waitFor(() => {
      expect(embeddingIndex.removed()).toEqual([{ path: 'notes/a.md', generation: 7 }])
    })
    stop()
  })

  it('starts no model load and no embedding work while semantic search is disabled', async () => {
    const { semanticSearch, runtime, embeddingIndex } = await setup({ enabled: false })

    const stop = semanticSearch.start()
    await flush()

    expect(runtime.ensureCalls()).toBe(0)
    expect(embeddingIndex.follows()).toEqual([])
    stop()
  })

  it('loads the model the moment the setting flips on', async () => {
    const { semanticSearch, settings, runtime, embeddingIndex } = await setup({
      enabled: false,
      status: { status: 'uninitialized' },
    })
    const stop = semanticSearch.start()
    await flush()
    expect(runtime.ensureCalls()).toBe(0)

    settings.update({ semanticSearchEnabled: true })
    await vi.waitFor(() => expect(runtime.ensureCalls()).toBe(1))

    // The download ends: the backfill and the follow start by themselves.
    runtime.setStatus(READY)
    expect(embeddingIndex.follows()).toEqual([{ generation: 7, modelId: TEST_EMBED_MODEL }])
    stop()
  })

  it('pauses follow-up work the moment semantic search is disabled', async () => {
    const { semanticSearch, settings, embeddingIndex, indexLifecycle } = await setup()
    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(embeddingIndex.follows()).toHaveLength(1))

    settings.update({ semanticSearchEnabled: false })
    // A batch still in flight when the teardown ran must be dropped, not
    // embedded behind the user's back.
    indexLifecycle.emitApplied([{ kind: 'remove', path: 'notes/b.md' }], 7)
    await flush()

    expect(embeddingIndex.removed()).toEqual([])
    stop()
  })

  it('never retries a failed load by itself', async () => {
    const { semanticSearch, runtime, embeddingIndex } = await setup({
      status: { status: 'failed', message: 'offline' },
    })

    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(runtime.get().status).toBe('failed'))
    await flush()

    // The one load an untouched runtime gets; `failed` starts no second one.
    expect(runtime.ensureCalls()).toBe(1)
    expect(embeddingIndex.follows()).toEqual([])
    stop()
  })

  it('unloads the model while the app is hidden and loads it again when visible', async () => {
    const { semanticSearch, runtime, embeddingIndex, activity } = await setup({
      unloadWhenHidden: true,
    })
    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(embeddingIndex.follows()).toHaveLength(1))
    const ensures = runtime.ensureCalls()

    activity.emitHidden()
    await vi.waitFor(() => expect(runtime.get().status).toBe('uninitialized'))
    await flush()
    expect(runtime.unloadCalls()).toBe(1)
    expect(runtime.ensureCalls()).toBe(ensures)

    runtime.setStatus(READY)
    await flush()
    expect(runtime.unloadCalls()).toBe(2) // a load that ends while hidden unloads too
    expect(embeddingIndex.follows()).toHaveLength(1)

    activity.emitVisible()
    await vi.waitFor(() => expect(runtime.ensureCalls()).toBe(ensures + 1))
    runtime.setStatus(READY)
    await vi.waitFor(() => expect(embeddingIndex.follows()).toHaveLength(2))
    stop()
  })

  it('reports the progress of the first backfill until the follow stops', async () => {
    const { semanticSearch, settings } = await setup({
      notes: [
        { path: 'notes/a.md', markdown: '# A\n\nAlpha text.\n' },
        { path: 'notes/b.md', markdown: '# B\n\nBeta text.\n' },
      ],
    })
    expect(semanticSearch.progress.get()).toBeNull()
    const seen: unknown[] = []
    const unsubscribe = semanticSearch.progress.subscribe(() => {
      seen.push(semanticSearch.progress.get())
    })
    const stop = semanticSearch.start()

    await vi.waitFor(() => expect(semanticSearch.progress.get()).toEqual({ done: 2, total: 2 }))
    expect(seen).toContainEqual({ done: 1, total: 2 })
    unsubscribe()
    settings.update({ semanticSearchEnabled: false })
    expect(semanticSearch.progress.get()).toBeNull()
    stop()
  })

  it('reports no progress for a backfill that only re-checks embedded notes', async () => {
    const { semanticSearch, settings, screen, logger } = await setup({
      notes: [
        { path: 'notes/a.md', markdown: '# A\n\nAlpha text.\n' },
        { path: 'notes/b.md', markdown: '# B\n\nBeta text.\n' },
      ],
    })
    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(semanticSearch.progress.get()).toEqual({ done: 2, total: 2 }))
    settings.update({ semanticSearchEnabled: false })
    const seen: unknown[] = []
    let maxHolds = 0
    const unsubscribe = semanticSearch.progress.subscribe(() => {
      seen.push(semanticSearch.progress.get())
      maxHolds = Math.max(maxHolds, screen.holds())
    })

    settings.update({ semanticSearchEnabled: true })
    await vi.waitFor(() => { return expect(
        logger.getInfos().filter((entry) => entry.message === 'embedding backfill finished'),
      ).toHaveLength(2) },
    )
    expect(seen.filter((progress) => progress !== null)).toEqual([])
    expect(maxHolds).toBe(0)
    unsubscribe()
    stop()
  })

  it('keeps the screen on while the first backfill runs', async () => {
    const { semanticSearch, screen } = await setup({
      notes: [
        { path: 'notes/a.md', markdown: '# A\n\nAlpha text.\n' },
        { path: 'notes/b.md', markdown: '# B\n\nBeta text.\n' },
      ],
    })
    const stop = semanticSearch.start()
    const holds = new Map<number, number>()
    const unsubscribe = semanticSearch.progress.subscribe(() => {
      const progress = semanticSearch.progress.get()
      if (progress !== null) {
        holds.set(progress.done, screen.holds())
      }
    })

    await vi.waitFor(() => expect(semanticSearch.progress.get()).toEqual({ done: 2, total: 2 }))
    expect(holds).toEqual(
      new Map([
        [1, 1],
        [2, 0],
      ]),
    )
    unsubscribe()
    stop()
  })

  it('lets the screen lock when the follow stops midway', async () => {
    const { semanticSearch, screen, settings } = await setup({
      notes: [
        { path: 'notes/a.md', markdown: '# A\n\nAlpha text.\n' },
        { path: 'notes/b.md', markdown: '# B\n\nBeta text.\n' },
      ],
    })
    const stop = semanticSearch.start()
    let holdsBeforeDisable: number | null = null
    let holdsAfterDisable: number | null = null
    const unsubscribe = semanticSearch.progress.subscribe(() => {
      const progress = semanticSearch.progress.get()
      if (progress?.done === 1 && holdsAfterDisable === null) {
        holdsBeforeDisable = screen.holds()
        settings.update({ semanticSearchEnabled: false })
        holdsAfterDisable = screen.holds()
      }
    })

    await vi.waitFor(() => expect(holdsAfterDisable).toBe(0))
    expect(holdsBeforeDisable).toBe(1)
    expect(semanticSearch.progress.get()).toBeNull()
    unsubscribe()
    stop()
  })

  it('lets the screen lock when the service stops midway', async () => {
    const { semanticSearch, screen } = await setup({
      notes: [
        { path: 'notes/a.md', markdown: '# A\n\nAlpha text.\n' },
        { path: 'notes/b.md', markdown: '# B\n\nBeta text.\n' },
      ],
    })
    const stop = semanticSearch.start()
    let holdsAfterStop: number | null = null
    const unsubscribe = semanticSearch.progress.subscribe(() => {
      if (semanticSearch.progress.get()?.done === 1 && holdsAfterStop === null) {
        stop()
        holdsAfterStop = screen.holds()
      }
    })

    await vi.waitFor(() => expect(holdsAfterStop).toBe(0))
    unsubscribe()
  })

  it('keeps the model loaded while hidden without `unloadWhenHidden`', async () => {
    const { semanticSearch, runtime, embeddingIndex, activity } = await setup()
    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(embeddingIndex.follows()).toHaveLength(1))

    activity.emitHidden()
    await flush()

    expect(runtime.unloadCalls()).toBe(0)
    expect(runtime.get()).toEqual(READY)
    stop()
  })

  it('does nothing in a secondary note window', async () => {
    const { semanticSearch, runtime, embeddingIndex } = await setup({ role: 'note-window' })

    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(runtime.get()).toEqual(READY))
    await flush()

    expect(runtime.ensureCalls()).toBe(0)
    expect(embeddingIndex.follows()).toEqual([])
    stop()
  })

  it('follows anew when another index session opens', async () => {
    const { semanticSearch, embeddingIndex, graphSession, indexLifecycle } = await setup()
    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(embeddingIndex.follows()).toHaveLength(1))

    graphSession.setState({ indexGeneration: 8 })

    expect(embeddingIndex.follows()).toEqual([
      { generation: 7, modelId: TEST_EMBED_MODEL },
      { generation: 8, modelId: TEST_EMBED_MODEL },
    ])
    // The first follow is over: a late batch of its generation is dropped.
    indexLifecycle.emitApplied([{ kind: 'remove', path: 'notes/a.md' }], 7)
    await flush()
    expect(embeddingIndex.removed()).toEqual([])
    stop()
  })

  it('does not follow while no index session is open', async () => {
    const { semanticSearch, runtime, embeddingIndex, graphSession } = await setup()
    graphSession.setState({ indexGeneration: null })

    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(runtime.get()).toEqual(READY))
    await flush()

    expect(embeddingIndex.follows()).toEqual([])
    stop()
  })

  it('reacts to nothing once stopped', async () => {
    const { semanticSearch, settings, runtime, embeddingIndex } = await setup({ enabled: false })
    const stop = semanticSearch.start()
    await flush()
    stop()

    settings.update({ semanticSearchEnabled: true })
    await flush()

    expect(runtime.ensureCalls()).toBe(0)
    expect(embeddingIndex.follows()).toEqual([])
    expect(semanticSearch.running()).toBe(0)
  })
})

describe('on an expensive connection', () => {
  it('waits for the connection status before it loads the model', async () => {
    const { semanticSearch, runtime, network } = await setup({
      status: { status: 'uninitialized' },
      expensive: null,
      downloaded: false,
    })
    const stop = semanticSearch.start()
    await expect(semanticSearch.needsDownloadConsent()).resolves.toBe(true)
    expect(runtime.ensureCalls()).toBe(0)

    network.setExpensive(true)
    await vi.waitFor(() => expect(semanticSearch.waitingForNetwork.get()).toBe(true))
    expect(runtime.ensureCalls()).toBe(0)
    stop()
  })

  it('waits for a free connection before it downloads the model', async () => {
    const { semanticSearch, runtime, network } = await setup({
      status: { status: 'uninitialized' },
      expensive: true,
      downloaded: false,
    })
    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(semanticSearch.waitingForNetwork.get()).toBe(true))
    expect(runtime.ensureCalls()).toBe(0)

    network.setExpensive(false)
    await vi.waitFor(() => expect(runtime.ensureCalls()).toBe(1))
    expect(semanticSearch.waitingForNetwork.get()).toBe(false)
    stop()
  })

  it('downloads the model once the user allows it', async () => {
    const { semanticSearch, runtime } = await setup({
      status: { status: 'uninitialized' },
      expensive: true,
      downloaded: false,
    })
    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(semanticSearch.waitingForNetwork.get()).toBe(true))
    await expect(semanticSearch.needsDownloadConsent()).resolves.toBe(true)

    semanticSearch.allowExpensiveDownload()
    await vi.waitFor(() => expect(runtime.ensureCalls()).toBe(1))
    expect(semanticSearch.waitingForNetwork.get()).toBe(false)
    await expect(semanticSearch.needsDownloadConsent()).resolves.toBe(false)
    stop()
  })

  it('loads a downloaded model without asking', async () => {
    const { semanticSearch, runtime } = await setup({
      status: { status: 'uninitialized' },
      expensive: true,
    })
    await expect(semanticSearch.needsDownloadConsent()).resolves.toBe(false)

    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(runtime.ensureCalls()).toBe(1))
    expect(semanticSearch.waitingForNetwork.get()).toBe(false)
    stop()
  })

  it('stops waiting when semantic search is turned off', async () => {
    const { semanticSearch, settings } = await setup({
      status: { status: 'uninitialized' },
      expensive: true,
      downloaded: false,
    })
    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(semanticSearch.waitingForNetwork.get()).toBe(true))

    settings.update({ semanticSearchEnabled: false })
    expect(semanticSearch.waitingForNetwork.get()).toBe(false)
    stop()
  })
})

describe('retryFailedModel', () => {
  it('re-kicks a failed load', async () => {
    const { semanticSearch, runtime } = await setup({
      status: { status: 'failed', message: 'offline' },
    })
    await semanticSearch.retryFailedModel()
    expect(runtime.ensureCalls()).toBe(1)
  })

  it('is a no-op for any other status', async () => {
    const { semanticSearch, runtime } = await setup()
    await semanticSearch.retryFailedModel()
    expect(runtime.ensureCalls()).toBe(0)
  })
})

describe('ensureModel', () => {
  it('resolves at once when the platform has no embedding runtime', async () => {
    const { semanticSearch } = await setup({ status: { status: 'unsupported' } })
    await expect(semanticSearch.ensureModel()).resolves.toEqual({ status: 'unsupported' })
  })

  it('resolves only at a terminal status (a racing ensure returns loading)', async () => {
    // Someone else is mid-download: ensure and the re-poll both answer loading.
    const { semanticSearch, runtime } = await setup({ status: { status: 'loading' } })

    let settled = false
    const pending = semanticSearch.ensureModel().then((status) => {
      settled = true
      return status
    })
    await vi.waitFor(() => expect(runtime.ensureCalls()).toBe(1))
    expect(settled).toBe(false)

    runtime.setStatus(READY)
    await expect(pending).resolves.toEqual(READY)
  })

  it('returns a failed status when the load fails', async () => {
    const { semanticSearch } = await setup({
      status: { status: 'failed', message: 'no disk space' },
    })
    const status = await semanticSearch.ensureModel()
    expect(status).toEqual({ status: 'failed', message: 'no disk space' })
  })
})

describe('similarNotes', () => {
  it('asks for the six nearest neighbors of the note', async () => {
    const hit: RetrievalHit = {
      path: 'notes/a.md',
      title: 'A',
      score: 0.9,
      snippet: '',
      heading: null,
      isPrivate: false,
    }
    const { semanticSearch, retrieval } = await setup({ relatedNotes: () => [hit] })

    await expect(semanticSearch.similarNotes('notes/x.md')).resolves.toEqual([hit])

    expect(retrieval.relatedNotesCalls()).toEqual([{ path: 'notes/x.md', limit: 6 }])
  })
})

describe('after an index rebuild', () => {
  it('re-embeds nothing while the model is not ready', async () => {
    const { indexLifecycle, embeddingIndex } = await setup({ status: { status: 'uninitialized' } })

    await indexLifecycle.rebuildVisibly()

    expect(indexLifecycle.rebuilds()).toEqual([7])
    expect(embeddingIndex.backfills()).toEqual([])
  })

  it('re-runs the embedding backfill when the model is ready', async () => {
    const { indexLifecycle, embeddingIndex } = await setup()

    await indexLifecycle.rebuildVisibly()
    await indexLifecycle.rebuildVisibly()

    // index_clear wiped the embedding tables; each rebuild repopulates them once.
    expect(embeddingIndex.backfills()).toEqual([
      { generation: 7, modelId: TEST_EMBED_MODEL },
      { generation: 7, modelId: TEST_EMBED_MODEL },
    ])
  })

  it('keeps the rebuild request in flight until the backfill ends', async () => {
    const backfill = Promise.withResolvers<EmbeddingBackfillResult>()
    const { indexLifecycle, embeddingIndex } = await setup({ backfill: () => backfill.promise })

    let settled = false
    const first = indexLifecycle.rebuildVisibly().then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(embeddingIndex.backfills()).toHaveLength(1))
    // A request made meanwhile coalesces onto the pass, its re-embed included.
    const second = indexLifecycle.rebuildVisibly()
    await flush()
    expect(settled).toBe(false)

    backfill.resolve('completed')
    await Promise.all([first, second])
    expect(embeddingIndex.backfills()).toHaveLength(1)
  })

  it('keeps the screen on while a rebuild backfill runs', async () => {
    const backfill = Promise.withResolvers<EmbeddingBackfillResult>()
    const { indexLifecycle, embeddingIndex, screen } = await setup({
      backfill: () => backfill.promise,
    })

    const rebuild = indexLifecycle.rebuildVisibly()
    await vi.waitFor(() => expect(embeddingIndex.backfills()).toHaveLength(1))
    expect(screen.holds()).toBe(1)

    backfill.resolve('completed')
    await rebuild
    expect(screen.holds()).toBe(0)
  })

  it('re-embeds nothing after a failed rebuild', async () => {
    const { indexLifecycle, embeddingIndex, progress } = await setup({ failClear: true })

    await expect(indexLifecycle.rebuildVisibly()).resolves.toBeUndefined()

    expect(progress.findByLabel('Rebuilding search index')?.status).toBe('failed')
    expect(embeddingIndex.backfills()).toEqual([])
  })

  it('re-embeds nothing after a background sync pass', async () => {
    const { indexLifecycle, embeddingIndex } = await setup()

    indexLifecycle.sync(
      createGraphSession({ root: '/g', name: 'g', generation: 1, indexGeneration: 7 }),
    )
    await indexLifecycle.settled()

    expect(embeddingIndex.backfills()).toEqual([])
    await indexLifecycle.close()
  })

  it('stops re-embedding once disposed', async () => {
    const { semanticSearch, indexLifecycle, embeddingIndex } = await setup()
    semanticSearch.dispose()

    await indexLifecycle.rebuildVisibly()

    expect(embeddingIndex.backfills()).toEqual([])
  })
})
