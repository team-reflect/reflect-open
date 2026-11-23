import { noop, sleep } from '@ocavue/utils'
import { createNoteDocumentService } from '../documents/note-document-service.ts'
import { createOpenDocumentsService } from '../documents/open-documents-service.ts'
import { createGraphSession, type GraphSession } from '../graph/graph-session.ts'
import type { DatabaseService } from '../indexing/database-service.ts'
import type { FileChange } from '../indexing/file-change-service.ts'
import type { IndexLifecycleService } from '../indexing/index-lifecycle-service.ts'
import type { ReconcileScan } from '../indexing/index-store-service.ts'
import { PROJECTION_VERSION } from '../indexing/indexed-note.ts'
import { PROJECTION_VERSION_KEY } from '../indexing/indexer.ts'
import { projectTasks } from '../markdown/index.ts'
import { WritableStore } from '../store.ts'
import { createTaskService, type TaskRef, type TaskService } from '../tasks/task-service.ts'
import { createTestClockService, type TestClockService } from './clock.ts'
import { createTestDatabaseService, type TestDatabaseService } from './database.ts'
import { createTestFileChangeService, type TestFileChangeService } from './file-change.ts'
import {
  createTestNoteFileService,
  overrideNoteFileService,
  type TestNoteFileService,
} from './graph.ts'
import { createTestIndexLifecycleService } from './index-lifecycle.ts'
import { createTestIndexStoreService, type TestIndexStoreService } from './index-store.ts'
import { createTestIpcBridgeService } from './ipc.ts'
import { createTestLoggerService } from './logger.ts'
import { createTestProgressPort } from './ports.ts'

const FILE_GENERATION = 1
const INDEX_GENERATION = 1

/**
 * The modification time of the first external edit, above every time the note file double stamps.
 */
const EXTERNAL_MODIFIED_MS_START = 1_000_000

/**
 * Longer than every timer of the task pipeline.
 */
const DRAIN_CLOCK_MS = 60_000

/**
 * A point where calls pass at once, or wait for a step while held.
 */
class StepGate {
  #held = false
  #waiting: PromiseWithResolvers<void>[] = []
  #arrival = Promise.withResolvers<void>()

  hold(): void {
    this.#held = true
  }

  /**
   * Stop holding and let every waiting call pass.
   */
  release(): void {
    this.#held = false
    for (const call of this.#waiting.splice(0)) {
      call.resolve()
    }
  }

  pass(): Promise<void> {
    if (!this.#held) {
      return Promise.resolve()
    }
    const call = Promise.withResolvers<void>()
    this.#waiting.push(call)
    this.#arrival.resolve()
    return call.promise
  }

  /**
   * Resolve once a call waits at the gate.
   */
  async arrived(): Promise<void> {
    while (this.#waiting.length === 0) {
      this.#arrival = Promise.withResolvers<void>()
      await this.#arrival.promise
    }
  }

  /**
   * Let the oldest waiting call pass, waiting for one to arrive first.
   */
  async land(): Promise<void> {
    await this.arrived()
    this.#waiting.shift()?.resolve()
  }

  /**
   * Reject the oldest waiting call with `error`, waiting for one to arrive first.
   */
  async fail(error: Error): Promise<void> {
    await this.arrived()
    this.#waiting.shift()?.reject(error)
  }
}

export interface TaskHarnessOptions {
  /**
   * Graph-relative paths to the contents of the notes on disk.
   */
  readonly files?: Readonly<Record<string, string>> | undefined
}

/**
 * The task pipeline over test doubles: note files, the file-change stream,
 * the index lifecycle, the index database, and the task service. Every
 * asynchronous hop is an event a test triggers one step at a time.
 */
export interface TaskHarness {
  readonly files: TestNoteFileService
  readonly fileChanges: TestFileChangeService
  readonly database: TestDatabaseService
  readonly indexStore: TestIndexStoreService
  readonly index: IndexLifecycleService
  readonly clock: TestClockService
  readonly tasks: TaskService
  readonly session: GraphSession
  /**
   * Run the first index pass, subscribe to the task list, and land its first read.
   */
  start(): Promise<void>
  /**
   * Change a note on disk as another app does. The watcher reports it in its next batch.
   */
  editExternally(path: string, contents: string): void
  /**
   * Make each task file write wait for {@link TaskHarness.landWrite}.
   */
  holdWrites(): void
  /**
   * Let the oldest held file write reach the disk.
   */
  landWrite(): Promise<void>
  /**
   * Make each task list read wait for {@link TaskHarness.landRead} or {@link TaskHarness.failRead}.
   */
  holdReads(): void
  /**
   * Let the oldest held task list read run and land.
   */
  landRead(): Promise<void>
  /**
   * Reject the oldest held task list read with `error`.
   */
  failRead(error: Error): Promise<void>
  /**
   * Report every file changed since the last batch as one watcher batch, and apply it.
   */
  deliverWatcherBatch(): Promise<void>
  /**
   * Start a refresh pass and stop it once its scan has listed the files.
   */
  startPass(): Promise<void>
  /**
   * Let the pass that {@link TaskHarness.startPass} stopped run to its end.
   */
  endPass(): Promise<void>
  /**
   * Suspend the index, as the app does when it hides.
   */
  suspend(): void
  /**
   * Resume the index and run its catch-up pass.
   */
  resume(): Promise<void>
  /**
   * Release every held step, deliver every unreported change, and run every timer.
   */
  drain(): Promise<void>
  /**
   * The open tasks the task list shows.
   */
  view(): TaskRef[]
  /**
   * The open tasks of the notes on disk, by note path, then by place in the note.
   */
  projectFiles(): TaskRef[]
  /**
   * Release the index database.
   */
  close(): void
}

// FIXME: is there any other places that will use `interface TaskHarness` but not `class TaskHarnessImpl`? If not, we can remove the interface and just export the class (e.g. rename TaskHarnessImpl to TaskHarness, move comments from interface into class, remove "createTaskHarness" and just export the class directly)
class TaskHarnessImpl implements TaskHarness {
  readonly files: TestNoteFileService
  readonly fileChanges: TestFileChangeService
  readonly database: TestDatabaseService
  readonly indexStore: TestIndexStoreService
  readonly index: IndexLifecycleService
  readonly clock: TestClockService
  readonly tasks: TaskService
  readonly session: GraphSession
  readonly #writes = new StepGate()
  readonly #reads = new StepGate()
  readonly #scans = new StepGate()
  readonly #unreported = new Set<string>()
  #externalModifiedMs = EXTERNAL_MODIFIED_MS_START
  #suspended = false

  constructor(options: TaskHarnessOptions) {
    this.files = createTestNoteFileService({
      files: options.files ?? {},
      generation: FILE_GENERATION,
    })
    this.fileChanges = createTestFileChangeService()
    this.database = createTestDatabaseService()
    this.clock = createTestClockService()
    this.session = createGraphSession({
      root: '/g',
      name: 'g',
      generation: FILE_GENERATION,
      indexGeneration: INDEX_GENERATION,
    })
    const graphSession = new WritableStore<{ readonly session: GraphSession | null }>({
      session: this.session,
    })
    const logger = createTestLoggerService()
    this.indexStore = createTestIndexStoreService({
      database: this.database,
      generation: INDEX_GENERATION,
      meta: { [PROJECTION_VERSION_KEY]: String(PROJECTION_VERSION) },
      scan: async () => {
        const scan = await this.#scanFiles()
        await this.#scans.pass()
        return scan
      },
    })
    this.index = createTestIndexLifecycleService({
      indexStore: this.indexStore,
      noteFile: this.files,
      fileChanges: this.fileChanges,
      database: this.database,
      clock: this.clock,
      logger,
      graphSession,
    })
    const steppedFiles = overrideNoteFileService(this.files, {
      write: async (path, contents, generation, expectedContents) => {
        await this.#writes.pass()
        const result = await this.files.write(path, contents, generation, expectedContents)
        this.#unreported.add(path)
        return result
      },
    })
    const steppedDatabase: DatabaseService = {
      read: async (command, args) => {
        await this.#reads.pass()
        return await this.database.read(command, args)
      },
    }
    this.tasks = createTaskService({
      database: steppedDatabase,
      noteDocuments: createNoteDocumentService({
        openDocuments: createOpenDocumentsService({ fileChanges: this.fileChanges }),
        noteFile: steppedFiles,
        graphSession,
      }),
      progress: createTestProgressPort(),
      clock: this.clock,
      logger,
      graphSession,
      indexLifecycle: this.index,
      role: 'main',
      ipc: createTestIpcBridgeService(),
    })
  }

  async start(): Promise<void> {
    this.index.sync(this.session)
    await this.index.settled()
    this.tasks.subscribe(noop)
    await sleep(0)
  }

  editExternally(path: string, contents: string): void {
    this.#externalModifiedMs += 1
    this.files.set(path, contents, { modifiedMs: this.#externalModifiedMs })
    this.#unreported.add(path)
  }

  holdWrites(): void {
    this.#writes.hold()
  }

  async landWrite(): Promise<void> {
    await this.#writes.land()
    await sleep(0)
  }

  holdReads(): void {
    this.#reads.hold()
  }

  async landRead(): Promise<void> {
    await this.#reads.land()
    await sleep(0)
  }

  async failRead(error: Error): Promise<void> {
    await this.#reads.fail(error)
    await sleep(0)
  }

  async deliverWatcherBatch(): Promise<void> {
    const listed = new Map(
      (await this.files.listNotes(FILE_GENERATION)).map((file) => [file.path, file]),
    )
    const changes = [...this.#unreported].map((path): FileChange => {
      const file = listed.get(path)
      return file === undefined
        ? { path, kind: 'remove' }
        : { path, kind: 'upsert', modifiedMs: file.modifiedMs }
    })
    this.#unreported.clear()
    if (changes.length === 0) {
      return
    }
    const applied = Promise.withResolvers<void>()
    const unlisten = this.index.onApplied((event) => {
      if (event.changes === changes) {
        applied.resolve()
      }
    })
    const admitted = !this.#suspended && this.fileChanges.listenerCount().changes > 0
    this.fileChanges.emit({ changes, source: 'external' })
    if (admitted) {
      await applied.promise
    }
    unlisten()
    await sleep(0)
  }

  async startPass(): Promise<void> {
    this.#scans.hold()
    this.index.refresh(this.session)
    await this.#scans.arrived()
  }

  async endPass(): Promise<void> {
    this.#scans.release()
    await sleep(0)
    await this.index.settled()
    await sleep(0)
  }

  suspend(): void {
    this.#suspended = true
    this.index.suspend()
  }

  async resume(): Promise<void> {
    this.#suspended = false
    this.index.resume(this.session)
    await sleep(0)
    await this.index.settled()
    await sleep(0)
  }

  async drain(): Promise<void> {
    this.#writes.release()
    this.#reads.release()
    this.#scans.release()
    do {
      await sleep(0)
      await this.index.settled()
      if (this.#unreported.size > 0) {
        await this.deliverWatcherBatch()
      }
      await this.clock.advance(DRAIN_CLOCK_MS)
      await sleep(0)
    } while (this.#unreported.size > 0)
  }

  view(): TaskRef[] {
    return (this.tasks.get().open ?? []).map(({ notePath, astPath, markdown, checked }) => {
      return { notePath, astPath, markdown, checked }
    })
  }

  projectFiles(): TaskRef[] {
    return [...this.files.files()]
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([notePath, source]) => {
        return projectTasks(source)
          .filter((task) => !task.checked)
          .map(({ astPath, markdown, checked }) => ({ notePath, astPath, markdown, checked }))
      })
  }

  close(): void {
    this.database.close()
  }

  async #scanFiles(): Promise<ReconcileScan> {
    const rows = new Map(
      this.database.query('SELECT path, mtime, file_hash FROM notes').map((row) => {
        return [
          String(row['path']),
          { mtime: Number(row['mtime']), hash: String(row['file_hash']) },
        ]
      }),
    )
    const listed = await this.files.listNotes(FILE_GENERATION)
    const listedPaths = new Set(listed.map((file) => file.path))
    return {
      total: listed.length,
      candidates: listed
        .filter((file) => rows.get(file.path)?.mtime !== file.modifiedMs)
        .map((file) => {
          const row = rows.get(file.path)
          return {
            path: file.path,
            modifiedMs: file.modifiedMs,
            storedMtime: row?.mtime ?? null,
            storedHash: row?.hash ?? null,
          }
        }),
      orphans: [...rows]
        .filter(([path]) => !listedPaths.has(path))
        .map(([path, row]) => ({ path, storedMtime: row.mtime, storedHash: row.hash })),
      stalePlaceholders: [],
    }
  }
}

/**
 * A {@link TaskHarness} over `options.files`, not started yet.
 */
export function createTaskHarness(options: TaskHarnessOptions): TaskHarness {
  return new TaskHarnessImpl(options)
}
