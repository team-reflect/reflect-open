import type { MaybePromise } from '@reflect/utils'
import type { ClockService } from '../ports/clock-service.ts'
import type { GraphRole, GraphSession } from '../graph/graph-session.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { PlatformFacts } from '../ports/platform-facts.ts'
import type { ActivityPort } from '../ports/activity-port.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import type { DatabaseService } from '../indexing/database-service.ts'
import type { FileChange, FileChangeService } from '../indexing/file-change-service.ts'
import {
  createIndexLifecycleService,
  type IndexAppliedEvent,
  type IndexFileProgress,
  type IndexLifecycleDeps,
  type IndexLifecycleProgress,
  type IndexLifecycleService,
  type IndexReconciledEvent,
} from '../indexing/index-lifecycle-service.ts'
import { createIndexQueryService, type IndexQueryService } from '../indexing/index-query-service.ts'
import type { IndexStoreService } from '../indexing/index-store-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type { XArchiveService } from '../embeds/x-archive-service.ts'
import { createTestXArchiveService } from './capture.ts'
import { createTestClockService } from './clock.ts'
import { createNodeTestDatabaseService } from './database.ts'
import { createTestFileChangeService } from './file-change.ts'
import { createTestNoteFileService } from './graph.ts'
import { createTestIndexStoreService } from './index-store.ts'
import { createTestLoggerService } from './logger.ts'
import { createTestPlatformService } from './platform.ts'
import { createTestProgressPort } from './ports.ts'
import { createTestActivityPort } from './shell.ts'

/**
 * The services a test lifecycle runs on; each defaults to a fresh test double.
 */
export interface TestIndexLifecycleServiceOptions {
  indexStore?: IndexStoreService
  noteFile?: NoteFileService
  fileChanges?: FileChangeService
  /**
   * Read lazily, so the default (Node only) costs nothing until a pass reads rows.
   */
  database?: DatabaseService
  /**
   * Defaults to one over `database`.
   */
  indexQuery?: IndexQueryService
  xArchive?: XArchiveService
  clock?: ClockService
  logger?: LoggerService
  progress?: ProgressPort
  /**
   * Where `rebuildVisibly` reads the open graph from; defaults to no graph open.
   */
  graphSession?: IndexLifecycleDeps['graphSession']
  /**
   * Defaults to a visible app.
   */
  activity?: ActivityPort
  /**
   * Defaults to desktop, where the lifecycle never follows the activity.
   */
  platform?: PlatformFacts
  role?: GraphRole
}

export interface TestIndexLifecycleService extends IndexLifecycleService {
  /**
   * Publish file progress as a running pass would; `null` clears it.
   */
  setFileProgress(progress: IndexFileProgress | null): void
  /**
   * The index generation of every `rebuildVisibly` request with an open index, in order.
   */
  rebuilds(): readonly number[]
  /**
   * Report `changes` as applied at `generation` to this lifecycle's
   * `onApplied` listeners, as an applied watcher batch (or, with `null`, a
   * sync pass) does.
   */
  emitApplied(changes: readonly FileChange[] | null, generation: number): void
}

class TestIndexLifecycleServiceImpl implements TestIndexLifecycleService {
  readonly #inner: IndexLifecycleService
  readonly #graphSession: IndexLifecycleDeps['graphSession']
  readonly #rebuildLog: number[] = []
  readonly #seededListeners = new Set<() => void>()
  readonly #appliedListeners = new Set<(event: IndexAppliedEvent) => void>()
  #seeded: { progress: IndexFileProgress | null } | null = null

  constructor(inner: IndexLifecycleService, graphSession: IndexLifecycleDeps['graphSession']) {
    this.#inner = inner
    this.#graphSession = graphSession
    inner.subscribeFileProgress(() => {
      this.#seeded = null
    })
  }

  open(): Promise<number | null> {
    return this.#inner.open()
  }

  sync(session: GraphSession): void {
    this.#inner.sync(session)
  }

  refresh(session: GraphSession): void {
    this.#inner.refresh(session)
  }

  stop(): Promise<void> {
    return this.#inner.stop()
  }

  settled(): Promise<void> {
    return this.#inner.settled()
  }

  close(): Promise<void> {
    return this.#inner.close()
  }

  suspend(): void {
    this.#inner.suspend()
  }

  resume(session: GraphSession | null): void {
    this.#inner.resume(session)
  }

  setSuspendGuard(shouldSuspend: (() => boolean) | null): void {
    this.#inner.setSuspendGuard(shouldSuspend)
  }

  followActivity(): Unlisten {
    return this.#inner.followActivity()
  }

  onProgress(listener: (progress: IndexLifecycleProgress) => void): Unlisten {
    return this.#inner.onProgress(listener)
  }

  onApplied(listener: (event: IndexAppliedEvent) => void): Unlisten {
    const unlisten = this.#inner.onApplied(listener)
    this.#appliedListeners.add(listener)
    return () => {
      unlisten()
      this.#appliedListeners.delete(listener)
    }
  }

  applyChanges(
    changes: FileChange[],
    generation: number,
    fileGeneration: number,
    canApply?: () => boolean,
  ): Promise<number> {
    return this.#inner.applyChanges(changes, generation, fileGeneration, canApply)
  }

  onReconciled(listener: (event: IndexReconciledEvent) => MaybePromise<void>): Unlisten {
    return this.#inner.onReconciled(listener)
  }

  onMoved(listener: (from: string, to: string) => void): Unlisten {
    return this.#inner.onMoved(listener)
  }

  onFileProgress(listener: (done: number, total: number, worked: number) => void): Unlisten {
    return this.#inner.onFileProgress(listener)
  }

  onStalePlaceholders(listener: (paths: readonly string[]) => void): Unlisten {
    return this.#inner.onStalePlaceholders(listener)
  }

  readonly fileProgress = (): IndexFileProgress | null =>
    this.#seeded !== null ? this.#seeded.progress : this.#inner.fileProgress()

  readonly subscribeFileProgress = (listener: () => void): Unlisten => {
    const unlisten = this.#inner.subscribeFileProgress(listener)
    this.#seededListeners.add(listener)
    return () => {
      unlisten()
      this.#seededListeners.delete(listener)
    }
  }

  rebuildVisibly(): Promise<void> {
    const generation = this.#graphSession.getState().session?.indexGeneration ?? null
    if (generation !== null) {
      this.#rebuildLog.push(generation)
    }
    return this.#inner.rebuildVisibly()
  }

  indexNote(
    path: string,
    options: {
      generation: number
      fileGeneration: number
      content?: string | undefined
      mtime?: number | undefined
    },
  ): Promise<void> {
    return this.#inner.indexNote(path, options)
  }

  reindexNotesReferencing(
    assetPaths: readonly string[],
    options: { generation: number; fileGeneration: number },
  ): Promise<void> {
    return this.#inner.reindexNotesReferencing(assetPaths, options)
  }

  setFileProgress(progress: IndexFileProgress | null): void {
    this.#seeded = { progress }
    for (const listener of this.#seededListeners) {
      listener()
    }
  }

  rebuilds(): readonly number[] {
    return [...this.#rebuildLog]
  }

  emitApplied(changes: readonly FileChange[] | null, generation: number): void {
    for (const listener of this.#appliedListeners) {
      listener({ generation, changes })
    }
  }
}

/**
 * The real {@link IndexLifecycleService} over test doubles, plus seeding and a rebuild log.
 */
export function createTestIndexLifecycleService(
  options?: TestIndexLifecycleServiceOptions,
): TestIndexLifecycleService {
  const database = options?.database ?? createNodeTestDatabaseService()
  const clock = options?.clock ?? createTestClockService()
  const graphSession = options?.graphSession ?? {
    getState: () => ({ session: null }),
    subscribe: () => () => {},
  }
  const inner = createIndexLifecycleService({
    indexStore: options?.indexStore ?? createTestIndexStoreService(),
    noteFile: options?.noteFile ?? createTestNoteFileService(),
    fileChanges: options?.fileChanges ?? createTestFileChangeService(),
    indexQuery: options?.indexQuery ?? createIndexQueryService({ database }),
    database,
    xArchive: options?.xArchive ?? createTestXArchiveService(),
    clock,
    logger: options?.logger ?? createTestLoggerService(),
    progress: options?.progress ?? createTestProgressPort(),
    graphSession,
    activity: options?.activity ?? createTestActivityPort(),
    platform: options?.platform ?? createTestPlatformService(),
    role: options?.role ?? 'main',
  })
  return new TestIndexLifecycleServiceImpl(inner, graphSession)
}
