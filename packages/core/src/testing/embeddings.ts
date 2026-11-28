import type { ChunkToEmbed } from '@reflect/types'
import type { MaybePromise } from '@reflect/utils'
import type { ActivityPort } from '../ports/activity-port.ts'
import type { ClockService } from '../ports/clock-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { SettingsService } from '../settings/settings-service.ts'
import type { StorageService } from '../ports/storage-service.ts'
import type { GraphRole } from '../graph/graph-session.ts'
import {
  createEmbeddingIndexService,
  type EmbedNoteOptions,
  type EmbeddingBackfillOptions,
  type EmbeddingBackfillResult,
  type EmbeddingFollowOptions,
  type EmbeddingIndexService,
} from '../embeddings/embedding-index-service.ts'
import {
  createEmbeddingRuntimeService,
  type EmbeddingRuntimeService,
  type EmbedStatus,
} from '../embeddings/embedding-runtime-service.ts'
import type {
  RetrievalHit,
  RetrievalService,
  RetrieveOptions,
} from '../embeddings/retrieval-service.ts'
import {
  createSemanticSearchService,
  type EmbeddingProgress,
  type SemanticSearchGraphSource,
  type SemanticSearchService,
} from '../embeddings/semantic-search-service.ts'
import { AppError } from '../errors.ts'
import type { Store } from '../store.ts'
import type { Unlisten } from '../unlisten.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import type { IndexLifecycleService } from '../indexing/index-lifecycle-service.ts'
import type { DatabaseService } from '../indexing/database-service.ts'
import {
  createTestDatabaseService,
  type TestDatabaseService,
  type TestEmbeddedChunk,
} from './database.ts'
import { createTestNoteFileService } from './graph.ts'
import { createTestGraphSessionService } from './graph-session.ts'
import { createTestIndexLifecycleService } from './index-lifecycle.ts'
import { createTestIpcBridgeService, type TestIpcBridgeService } from './ipc.ts'
import { createTestClockService } from './clock.ts'
import { createTestActivityPort } from './shell.ts'
import { createTestLoggerService } from './logger.ts'
import { createTestSettingsService } from './settings.ts'
import { createTestStorageService } from './storage.ts'

export interface TestEmbeddingRuntimeServiceOptions {
  /**
   * The runtime status. Defaults to `ready` with model `TEST_EMBED_MODEL`.
   */
  status?: EmbedStatus | undefined
  /**
   * The vector for one text. Defaults to a unit vector.
   */
  vectors?: (text: string) => number[]
}

export interface TestEmbeddingRuntimeService extends EmbeddingRuntimeService {
  /**
   * Change the runtime status and emit it as a status event.
   */
  setStatus(status: EmbedStatus): void
  /**
   * Gives each chunk a vector and the model id. Throws unless the status is
   * `ready` or there are no chunks.
   */
  embedChunks(chunks: readonly ChunkToEmbed[]): TestEmbeddedChunk[]
  /**
   * The texts of every `embedQuery` (one text) and `embedChunks` call, in
   * order.
   */
  embedCalls(): readonly (readonly string[])[]
  /**
   * How many times `ensure` ran.
   */
  ensureCalls(): number
  /**
   * How many times `unload` ran.
   */
  unloadCalls(): number
}

/**
 * The model id of the test embedding runtime.
 */
export const TEST_EMBED_MODEL = 'test-model'

/**
 * The vector width of the index (`EMBEDDING_DIMS` in `reflect-index-schema`).
 */
export const TEST_EMBED_DIMENSIONS = 256

function unitVector(): number[] {
  const vector = Array.from({ length: TEST_EMBED_DIMENSIONS }, () => 0)
  vector[0] = 1
  return vector
}

class TestEmbeddingRuntimeServiceImpl implements TestEmbeddingRuntimeService {
  readonly #inner: EmbeddingRuntimeService
  readonly #ipc: TestIpcBridgeService
  readonly #embedded: string[][] = []
  readonly #vectors: (text: string) => number[]
  #status: EmbedStatus
  #ensures = 0
  #unloads = 0

  constructor(options?: TestEmbeddingRuntimeServiceOptions) {
    this.#status = options?.status ?? { status: 'ready', model: TEST_EMBED_MODEL }
    this.#vectors = options?.vectors ?? unitVector
    this.#ipc = createTestIpcBridgeService({
      commands: {
        embed_status: () => this.#status,
        embed_ensure: () => {
          this.#ensures++
          return this.#status
        },
        embed_query: (args) => this.#embed([String(args['text'])])[0],
        embed_unload: () => {
          this.#unloads++
          if (this.#status.status === 'ready') {
            this.setStatus({ status: 'uninitialized' })
          }
          return null
        },
      },
    })
    this.#inner = createEmbeddingRuntimeService({
      ipc: this.#ipc,
      logger: createTestLoggerService(),
    })
  }

  status(): Promise<EmbedStatus> {
    return this.#inner.status()
  }

  ensure(): Promise<EmbedStatus> {
    return this.#inner.ensure()
  }

  awaitTerminalStatus(initial: EmbedStatus): Promise<EmbedStatus> {
    return this.#inner.awaitTerminalStatus(initial)
  }

  retry(): Promise<EmbedStatus> {
    return this.#inner.retry()
  }

  embedQuery(text: string): Promise<number[]> {
    return this.#inner.embedQuery(text)
  }

  unload(): Promise<void> {
    return this.#inner.unload()
  }

  embedChunks(chunks: readonly ChunkToEmbed[]): TestEmbeddedChunk[] {
    if (chunks.length === 0) {
      return []
    }
    const vectors = this.#embed(chunks.map((chunk) => chunk.text))
    const modelId = this.#status.status === 'ready' ? this.#status.model : ''
    return chunks.map((chunk, i) => ({ ...chunk, modelId, vector: vectors[i]! }))
  }

  readonly get = (): EmbedStatus => this.#inner.get()

  readonly subscribe = (listener: VoidFunction): Unlisten => this.#inner.subscribe(listener)

  setStatus(next: EmbedStatus): void {
    this.#status = next
    this.#ipc.emit('embed:status', next)
  }

  embedCalls(): readonly (readonly string[])[] {
    return this.#embedded.map((texts) => [...texts])
  }

  ensureCalls(): number {
    return this.#ensures
  }

  unloadCalls(): number {
    return this.#unloads
  }

  #embed(texts: string[]): number[][] {
    if (this.#status.status !== 'ready') {
      throw new AppError('unknown', `embedding model is ${this.#status.status}`)
    }
    if (texts.length > 0) {
      this.#embedded.push(texts)
    }
    return texts.map((text) => this.#vectors(text))
  }
}

/**
 * The real {@link EmbeddingRuntimeService} over a scripted runtime. `ensure`
 * answers the current status without loading anything: drive loads with
 * `setStatus`. `embedQuery` rejects and `embedChunks` throws unless the status
 * is `ready`, like the native runtime.
 */
export function createTestEmbeddingRuntimeService(
  options?: TestEmbeddingRuntimeServiceOptions,
): TestEmbeddingRuntimeService {
  return new TestEmbeddingRuntimeServiceImpl(options)
}

export interface TestRetrievalServiceOptions {
  /**
   * Answers `retrieve`. Defaults to no hits.
   */
  retrieve?: (query: string, options?: RetrieveOptions) => MaybePromise<RetrievalHit[]>
  /**
   * Answers `relatedNotes`. Defaults to no neighbors.
   */
  relatedNotes?: (path: string, limit?: number) => MaybePromise<RetrievalHit[]>
}

export interface TestRetrievalService extends RetrievalService {
  /**
   * Every `retrieve` call, in order.
   */
  retrieveCalls(): readonly { readonly query: string; readonly options?: RetrieveOptions }[]
  /**
   * Every `relatedNotes` call, in order.
   */
  relatedNotesCalls(): readonly { readonly path: string; readonly limit?: number }[]
}

class TestRetrievalServiceImpl implements TestRetrievalService {
  readonly #options: TestRetrievalServiceOptions | undefined
  readonly #retrieveLog: { query: string; options?: RetrieveOptions }[] = []
  readonly #relatedLog: { path: string; limit?: number }[] = []

  constructor(options?: TestRetrievalServiceOptions) {
    this.#options = options
  }

  async retrieve(query: string, retrieveOptions?: RetrieveOptions): Promise<RetrievalHit[]> {
    this.#retrieveLog.push(
      retrieveOptions === undefined ? { query } : { query, options: retrieveOptions },
    )
    return (await this.#options?.retrieve?.(query, retrieveOptions)) ?? []
  }

  async relatedNotes(path: string, limit?: number): Promise<RetrievalHit[]> {
    this.#relatedLog.push(limit === undefined ? { path } : { path, limit })
    return (await this.#options?.relatedNotes?.(path, limit)) ?? []
  }

  retrieveCalls(): readonly { readonly query: string; readonly options?: RetrieveOptions }[] {
    return [...this.#retrieveLog]
  }

  relatedNotesCalls(): readonly { readonly path: string; readonly limit?: number }[] {
    return [...this.#relatedLog]
  }
}

/**
 * A scripted {@link RetrievalService}: the real one needs the vector
 * extension of the Node test database, which browser tests do not have.
 */
export function createTestRetrievalService(
  options?: TestRetrievalServiceOptions,
): TestRetrievalService {
  return new TestRetrievalServiceImpl(options)
}

/**

 * One recorded `embed_note_chunks`: the complete new chunk set of a note.

 */
export interface TestEmbeddingApply {
  readonly path: string
  readonly chunks: readonly ChunkToEmbed[]
  readonly generation: number
}

/**

 * One recorded `embed_note_chunks` with an empty chunk set.

 */
export interface TestEmbeddingRemove {
  readonly path: string
  readonly generation: number
}

/**

 * The services a test embedding index runs on; each defaults to a fresh test double.

 */
export interface TestEmbeddingIndexServiceOptions {
  /**
   * Embeds the chunks of `embed_note_chunks`.
   */
  embeddingRuntime?: TestEmbeddingRuntimeService
  noteFile?: NoteFileService
  /**
   * Read lazily, so the default costs nothing until a note is embedded.
   * Defaults to `storeChunksIn`, else to a new test database.
   */
  database?: DatabaseService
  indexLifecycle?: IndexLifecycleService
  logger?: LoggerService
  clock?: ClockService
  /**
   * Write chunk sets into this database, so later passes and retrieval read
   * them back. Every chunk gets a new vector: the native writer's reuse of
   * stored vectors is not modeled. Without it, writes are only recorded.
   */
  storeChunksIn?: TestDatabaseService
  /**
   * Answers `backfill` calls in place of the real pass; a `follow` still runs the real one.
   */
  backfill?: ((options: EmbeddingBackfillOptions) => Promise<EmbeddingBackfillResult>) | undefined
  /**
   * Called before a chunk set is written. A returned `Error`
   * rejects the write with it, unrecorded.
   */
  failApply?: (apply: TestEmbeddingApply) => Error | undefined
}

export interface TestEmbeddingIndexService extends EmbeddingIndexService {
  /**
   * Every non-empty chunk set that `embed_note_chunks` wrote, in order.
   */
  applied(): readonly TestEmbeddingApply[]
  /**
   * Every empty chunk set that `embed_note_chunks` wrote, in order, including
   * the one an emptied note causes.
   */
  removed(): readonly TestEmbeddingRemove[]
  /**
   * The `generation` and `modelId` of every `backfill` call, in order. The
   * backfill a `follow` starts is not a call.
   */
  backfills(): readonly { readonly generation: number; readonly modelId: string }[]
  /**
   * The `generation` and `modelId` of every `follow` call, in order.
   */
  follows(): readonly { readonly generation: number; readonly modelId: string }[]
}

class TestEmbeddingIndexServiceImpl implements TestEmbeddingIndexService {
  readonly #inner: EmbeddingIndexService
  readonly #backfillOverride: TestEmbeddingIndexServiceOptions['backfill']
  readonly #applyLog: TestEmbeddingApply[] = []
  readonly #removeLog: TestEmbeddingRemove[] = []
  readonly #backfillLog: { generation: number; modelId: string }[] = []
  readonly #followLog: { generation: number; modelId: string }[] = []

  constructor(options?: TestEmbeddingIndexServiceOptions) {
    const store = options?.storeChunksIn ?? null
    const database = options?.database ?? store ?? createTestDatabaseService()
    const embeddingRuntime = options?.embeddingRuntime ?? createTestEmbeddingRuntimeService()
    this.#backfillOverride = options?.backfill
    const ipc = createTestIpcBridgeService({
      commands: {
        embed_note_chunks: (args) => {
          const apply = args as unknown as TestEmbeddingApply
          const chunks = embeddingRuntime.embedChunks(apply.chunks)
          const failure = options?.failApply?.(apply)
          if (failure !== undefined) {
            throw failure
          }
          if (chunks.length === 0) {
            this.#removeLog.push({ path: apply.path, generation: apply.generation })
          } else {
            this.#applyLog.push(apply)
          }
          store?.applyEmbeddings(apply.path, chunks)
          return chunks.length
        },
      },
    })
    this.#inner = createEmbeddingIndexService({
      ipc,
      noteFile: options?.noteFile ?? createTestNoteFileService(),
      database,
      indexLifecycle: options?.indexLifecycle ?? createTestIndexLifecycleService({ database }),
      logger: options?.logger ?? createTestLoggerService(),
      clock: options?.clock ?? createTestClockService(),
    })
  }

  embedNote(options: EmbedNoteOptions): Promise<number> {
    return this.#inner.embedNote(options)
  }

  removeNote(path: string, generation: number): Promise<void> {
    return this.#inner.removeNote(path, generation)
  }

  backfill(backfillOptions: EmbeddingBackfillOptions): Promise<EmbeddingBackfillResult> {
    this.#backfillLog.push({
      generation: backfillOptions.generation,
      modelId: backfillOptions.modelId,
    })
    return this.#backfillOverride?.(backfillOptions) ?? this.#inner.backfill(backfillOptions)
  }

  follow(followOptions: EmbeddingFollowOptions): Unlisten {
    this.#followLog.push({ generation: followOptions.generation, modelId: followOptions.modelId })
    return this.#inner.follow(followOptions)
  }

  applied(): readonly TestEmbeddingApply[] {
    return [...this.#applyLog]
  }

  removed(): readonly TestEmbeddingRemove[] {
    return [...this.#removeLog]
  }

  backfills(): readonly { readonly generation: number; readonly modelId: string }[] {
    return [...this.#backfillLog]
  }

  follows(): readonly { readonly generation: number; readonly modelId: string }[] {
    return [...this.#followLog]
  }
}

/**
 * The real {@link EmbeddingIndexService} over test doubles, recording every
 * native chunk write.
 */
export function createTestEmbeddingIndexService(
  options?: TestEmbeddingIndexServiceOptions,
): TestEmbeddingIndexService {
  return new TestEmbeddingIndexServiceImpl(options)
}

/**

 * The services a test semantic search runs on; each defaults to a fresh test double.

 */
export interface TestSemanticSearchServiceOptions {
  embeddingRuntime?: EmbeddingRuntimeService
  embeddingIndex?: EmbeddingIndexService
  retrieval?: RetrievalService
  settings?: SettingsService
  storage?: StorageService
  role?: GraphRole
  indexLifecycle?: IndexLifecycleService
  graphSession?: SemanticSearchGraphSource
  activity?: ActivityPort
  unloadWhenHidden?: boolean
  logger?: LoggerService
}

export interface TestSemanticSearchService extends SemanticSearchService {
  /**
   * How many `start` calls have not been stopped yet.
   */
  running(): number
}

class TestSemanticSearchServiceImpl implements TestSemanticSearchService {
  readonly #inner: SemanticSearchService
  readonly progress: Store<EmbeddingProgress | null>
  #running = 0

  constructor(inner: SemanticSearchService) {
    this.#inner = inner
    this.progress = inner.progress
  }

  start(): Unlisten {
    const stop = this.#inner.start()
    this.#running += 1
    let stopped = false
    return () => {
      if (!stopped) {
        stopped = true
        this.#running -= 1
      }
      stop()
    }
  }

  ensureModel(): Promise<EmbedStatus> {
    return this.#inner.ensureModel()
  }

  retryFailedModel(): Promise<void> {
    return this.#inner.retryFailedModel()
  }

  similarNotes(path: string): Promise<RetrievalHit[]> {
    return this.#inner.similarNotes(path)
  }

  dispose(): void {
    this.#inner.dispose()
  }

  running(): number {
    return this.#running
  }
}

/**

 * The real {@link SemanticSearchService} over test doubles.

 */
export function createTestSemanticSearchService(
  options?: TestSemanticSearchServiceOptions,
): TestSemanticSearchService {
  const embeddingRuntime = options?.embeddingRuntime ?? createTestEmbeddingRuntimeService()
  const indexLifecycle = options?.indexLifecycle ?? createTestIndexLifecycleService()
  const logger = options?.logger ?? createTestLoggerService()
  return new TestSemanticSearchServiceImpl(
    createSemanticSearchService({
      embeddingRuntime,
      embeddingIndex:
        options?.embeddingIndex ?? createTestEmbeddingIndexService({ indexLifecycle, logger }),
      retrieval: options?.retrieval ?? createTestRetrievalService(),
      settings: options?.settings ?? createTestSettingsService(),
      storage: options?.storage ?? createTestStorageService(),
      role: options?.role ?? 'main',
      indexLifecycle,
      graphSession:
        options?.graphSession ?? createTestGraphSessionService({ indexLifecycle, logger }),
      activity: options?.activity ?? createTestActivityPort(),
      unloadWhenHidden: options?.unloadWhenHidden ?? false,
      logger,
    }),
  )
}
