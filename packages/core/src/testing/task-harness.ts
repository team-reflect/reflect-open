import { sha256HexSync } from '@reflect/utils'
import { noop, sleep } from '@ocavue/utils'
import {
  createNoteDocumentService,
  type NoteDocumentService,
} from '../documents/note-document-service.ts'
import { createTestNoteSessionService, createTestLinkedDayService } from './documents.ts'
import { createGraphSession, type GraphSession } from '../graph/graph-session.ts'
import type { DatabaseService } from '../indexing/database-service.ts'
import type { FileChange } from '../indexing/file-change-service.ts'
import type { IndexLifecycleService } from '../indexing/index-lifecycle-service.ts'
import type { ReconcileScan } from '../indexing/index-store-service.ts'
import { PROJECTION_VERSION } from '../indexing/indexed-note.ts'
import { PROJECTION_VERSION_KEY } from '../indexing/indexer.ts'
import { projectTasks, type TaskLocator } from '../markdown/index.ts'
import { WritableStore } from '../store.ts'
import type { OpenTask } from '../tasks/open-task.ts'
import { createTaskService, type TaskService } from '../tasks/task-service.ts'
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
import { createTestIpcBridgeService, type TestIpcBridgeService } from './ipc.ts'
import { createTestLoggerService } from './logger.ts'
import { createTestProgressPort, type TestProgressPort } from './ports.ts'

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

/**
 * The address of a task: its note and its locator.
 */
export interface TaskAddress extends TaskLocator {
  notePath: string
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
export class TaskHarness {
  readonly files: TestNoteFileService
  readonly fileChanges: TestFileChangeService
  readonly database: TestDatabaseService
  readonly indexStore: TestIndexStoreService
  readonly index: IndexLifecycleService
  readonly clock: TestClockService
  readonly documents: NoteDocumentService
  readonly tasks: TaskService
  readonly progress: TestProgressPort
  readonly session: GraphSession
  readonly #writes = new StepGate()
  readonly #reads = new StepGate()
  readonly #scans = new StepGate()
  readonly #unreported = new Set<string>()
  readonly #ipc: TestIpcBridgeService
  #externalModifiedMs = EXTERNAL_MODIFIED_MS_START

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
    const ipc = createTestIpcBridgeService()
    this.#ipc = ipc
    this.indexStore = createTestIndexStoreService({
      database: this.database,
      ipc,
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
    this.fileChanges.subscribeReconcile(() => {
      this.index.refresh(this.session)
    })
    const steppedFiles = overrideNoteFileService(this.files, {
      write: async (path, contents, generation, expectedContents, onMismatch) => {
        await this.#writes.pass()
        const result = await this.files.write(
          path,
          contents,
          generation,
          expectedContents,
          onMismatch,
        )
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
    this.documents = createNoteDocumentService({
      noteSessions: createTestNoteSessionService(),
      noteFile: steppedFiles,
      graphSession,
      indexLifecycle: this.index,
      linkedDays: createTestLinkedDayService(),
      logger,
    })
    this.progress = createTestProgressPort()
    this.tasks = createTaskService({
      database: steppedDatabase,
      noteDocuments: this.documents,
      progress: this.progress,
      clock: this.clock,
      logger,
      graphSession,
      ipc,
    })
  }

  /**
   * Run the first index pass, subscribe to the task list, and land its first read.
   */
  async start(): Promise<void> {
    this.index.sync(this.session)
    await this.index.settled()
    this.tasks.subscribe(noop)
    await sleep(0)
  }

  /**
   * Broadcast an index commit that names no note: the task list reads every note again.
   */
  reportCommit(): void {
    this.#ipc.emit('index:committed', { seq: 0, paths: null })
  }

  /**
   * Change a note on disk as another app does. The watcher reports it in its next batch.
   */
  editExternally(path: string, contents: string): void {
    this.#externalModifiedMs += 1
    this.files.set(path, contents, { modifiedMs: this.#externalModifiedMs })
    this.#unreported.add(path)
  }

  /**
   * Make each task file write wait for {@link TaskHarness.landWrite}.
   */
  holdWrites(): void {
    this.#writes.hold()
  }

  /**
   * Let the oldest held file write reach the disk.
   */
  async landWrite(): Promise<void> {
    await this.#writes.land()
    await sleep(0)
  }

  /**
   * Make each task list read wait for {@link TaskHarness.landRead} or {@link TaskHarness.failRead}.
   */
  holdReads(): void {
    this.#reads.hold()
  }

  /**
   * Let the oldest held task list read run and land.
   */
  async landRead(): Promise<void> {
    await this.#reads.land()
    await sleep(0)
  }

  /**
   * Reject the oldest held task list read with `error`.
   */
  async failRead(error: Error): Promise<void> {
    await this.#reads.fail(error)
    await sleep(0)
  }

  /**
   * Report every file changed since the last batch as one watcher batch, and wait for the index writer.
   */
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
    this.fileChanges.emit({ changes, source: 'external' })
    await this.index.drained()
    await sleep(0)
  }

  /**
   * Start a refresh pass and stop it once its scan has listed the files.
   */
  async startPass(): Promise<void> {
    this.#scans.hold()
    this.index.refresh(this.session)
    await this.#scans.arrived()
  }

  /**
   * Let the pass that {@link TaskHarness.startPass} stopped run to its end.
   */
  async endPass(): Promise<void> {
    this.#scans.release()
    await sleep(0)
    await this.index.settled()
    await sleep(0)
  }

  /**
   * Fail the pass that waits at its scan with `error`. Later passes run freely.
   */
  async failPass(error: Error): Promise<void> {
    await this.#scans.fail(error)
    this.#scans.release()
    await sleep(0)
    await this.index.settled()
  }

  /**
   * Lose every change not yet reported, as a watcher error does. The pass
   * the watcher then demands stops once its scan has listed the files.
   */
  async failWatcher(): Promise<void> {
    this.#unreported.clear()
    this.#scans.hold()
    this.fileChanges.emitReconcile()
    await this.#scans.arrived()
  }

  /**
   * Suspend the index, as the app does when it hides.
   */
  suspend(): void {
    this.index.suspend()
  }

  /**
   * Resume the index and run its catch-up pass.
   */
  async resume(): Promise<void> {
    this.index.resume(this.session)
    await sleep(0)
    await this.index.settled()
    await sleep(0)
  }

  /**
   * Release every held step, deliver every unreported change, and run every timer.
   */
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
      await this.index.settled()
      await this.index.drained()
      await sleep(0)
    } while (this.#unreported.size > 0)
  }

  /**
   * Type `markdown` into the editor of `task` and leave the row.
   */
  edit(task: OpenTask, markdown: string): Promise<void> {
    this.tasks.commands.setDraft(task, markdown)
    return this.tasks.commands.commit(task)
  }

  /**
   * The open tasks the task list shows.
   */
  view(): TaskAddress[] {
    return (this.tasks.get().open ?? []).map(
      ({ notePath, revision, astPath, markdown, checked }) => {
        return { notePath, revision, astPath, markdown, checked }
      },
    )
  }

  /**
   * The open tasks of the notes on disk, by note path, then by place in the note.
   */
  projectFiles(): TaskAddress[] {
    return [...this.files.files()]
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([notePath, source]) => {
        const revision = sha256HexSync(source)
        return projectTasks(source)
          .filter((task) => !task.checked)
          .map(({ astPath, markdown, checked }) => {
            return { notePath, revision, astPath, markdown, checked }
          })
      })
  }

  /**
   * Release the index database.
   */
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
