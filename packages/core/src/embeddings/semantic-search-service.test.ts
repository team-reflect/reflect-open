import { describe, expect, it, vi } from 'vitest'
import { createGraphSession, type GraphRole } from '../graph/graph-session.ts'
import {
  createTestEmbeddingIndexService,
  createTestEmbeddingRuntimeService,
  createTestGraphSessionService,
  createTestIndexLifecycleService,
  createTestIndexStoreService,
  createTestLoggerService,
  createTestProgressPort,
  createTestRetrievalService,
  createTestSemanticSearchService,
  createTestSettingsService,
  createTestStorageService,
} from '../testing/index.ts'
import type { EmbeddingBackfillResult } from './embedding-index-service.ts'
import type { EmbedStatus } from './embedding-runtime-service.ts'
import type { RetrievalHit } from './retrieval-service.ts'

const MODEL = 'all-MiniLM-L6-v2'
const READY: EmbedStatus = { status: 'ready', model: MODEL }
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
  const runtime = createTestEmbeddingRuntimeService({ status: options?.status ?? READY })
  const session = createGraphSession({ ...GRAPH, indexGeneration: 7 })
  const indexLifecycle = createTestIndexLifecycleService({
    logger,
    progress,
    graphSession: { getState: () => ({ session }), subscribe: () => () => {} },
    indexStore: createTestIndexStoreService({
      fail: (call) => {
        return options?.failClear === true && call.method === 'clear'
          ? new Error('index on fire')
          : undefined
      },
    }),
  })
  const embeddingIndex = createTestEmbeddingIndexService({
    embeddingRuntime: runtime,
    indexLifecycle,
    logger,
    ...(options?.backfill === undefined ? {} : { backfill: options.backfill }),
  })
  const retrieval = createTestRetrievalService(
    options?.relatedNotes === undefined ? {} : { relatedNotes: options.relatedNotes },
  )
  const graphSession = createTestGraphSessionService({
    indexLifecycle,
    logger,
    state: { graph: GRAPH, indexGeneration: 7 },
  })
  const semanticSearch = createTestSemanticSearchService({
    embeddingRuntime: runtime,
    embeddingIndex,
    retrieval,
    settings,
    storage,
    role: options?.role ?? 'main',
    indexLifecycle,
    graphSession,
    logger,
  })
  return {
    semanticSearch,
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
  return new Promise((resolve) => setTimeout(resolve, 0))
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
    expect(embeddingIndex.follows()).toEqual([{ generation: 7, modelId: MODEL }])
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
    expect(embeddingIndex.follows()).toEqual([{ generation: 7, modelId: MODEL }])
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
    await vi.waitFor(() => expect(runtime.lastStatus().status).toBe('failed'))
    await flush()

    // The one load an untouched runtime gets; `failed` starts no second one.
    expect(runtime.ensureCalls()).toBe(1)
    expect(embeddingIndex.follows()).toEqual([])
    stop()
  })

  it('does nothing in a secondary note window', async () => {
    const { semanticSearch, runtime, embeddingIndex } = await setup({ role: 'note-window' })

    const stop = semanticSearch.start()
    await vi.waitFor(() => expect(runtime.lastStatus()).toEqual(READY))
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
      { generation: 7, modelId: MODEL },
      { generation: 8, modelId: MODEL },
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
    await vi.waitFor(() => expect(runtime.lastStatus()).toEqual(READY))
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
      { generation: 7, modelId: MODEL },
      { generation: 7, modelId: MODEL },
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
