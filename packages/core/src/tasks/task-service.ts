import { isShallowEqual } from '@ocavue/utils'
import { errorMessage } from '../errors.ts'
import type { ClockService } from '../ports/clock-service.ts'
import type { GraphSession } from '../graph/graph-session.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import type { NoteDocumentService } from '../documents/note-document-service.ts'
import type { DatabaseService } from '../indexing/database-service.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import type { SnippetTask } from '../indexing/snippet-tasks.ts'
import { WritableStore, type Store } from '../store.ts'
import type { Unlisten } from '../unlisten.ts'
import type { TaskLocator } from '../markdown/index.ts'
import { TaskCommands } from './task-commands.ts'
import { createTaskReader, type TaskReader } from './task-reader.ts'
import { TaskStore, type TaskStoreView } from './task-store.ts'

export interface TaskServiceDeps {
  readonly database: DatabaseService
  readonly noteDocuments: NoteDocumentService
  readonly progress: ProgressPort
  readonly clock: ClockService
  readonly logger: LoggerService
  readonly graphSession: Store<{ readonly session: GraphSession | null }>
  readonly ipc: IpcBridgeService
}

/**
 * A click on the `index`th checkbox of a rendered snippet, as the view reports it.
 */
interface SnippetTaskClick {
  index: number
  checked: boolean
  text: string
}

/**
 * Reads, edits and adds round-checkbox tasks across notes (Plan 18), plus the
 * struck set.
 *
 * The struck set is V1's middle state where a checked task keeps showing
 * (struck) in the list until you archive it. It is view state, not durable
 * state: a checked task is already `[x]` on disk, and "archived" only means
 * "stop showing it in the active list", which the markdown does not encode.
 * It holds the ids of the tasks this service completed, so it resets on app
 * restart and on a graph switch, and it survives navigating away from Tasks
 * and back. A fresh launch is clean: only what you checked in this run
 * lingers struck, and the whole historical pile stays behind the "show
 * archived" filter.
 */
export interface TaskService extends Store<TaskStoreView> {
  /**
   * The open graph's task rows. Private notes' tasks are included because
   * this is a local-only surface. The same object is returned until the rows
   * or the open graph change.
   */
  get: () => TaskStoreView
  /**
   * Call `listener` whenever {@link TaskService.get} changes. The first
   * subscription reads the open tasks; while any listener is subscribed, a
   * commit to the index re-reads the tasks of the notes it names, or of every
   * note when it names none. While nothing is subscribed, the service does
   * not follow the index, and the next subscription reads the rows again.
   */
  subscribe: (listener: VoidFunction) => Unlisten
  /**
   * Read the completed tasks too, and keep them fresh, until the returned
   * function runs.
   */
  includeCompleted(): Unlisten
  /**
   * The changes the user makes to tasks.
   */
  readonly commands: TaskCommands
  /**
   * The clicked snippet checkbox against the anchor for the same index. The
   * view and the anchors enumerate the same markdown independently (the
   * render walk vs the core's parse — see `extractSnippetTasks`), so index,
   * state, and the item's own first-line text must all agree; any mismatch
   * means the two walks drifted, and a toggle would hit the wrong task. A
   * drift is reported as a failed operation and answers `null`.
   */
  resolveSnippetTask(tasks: readonly SnippetTask[], click: SnippetTaskClick): SnippetTask | null
  /**
   * Write a backlink-snippet checkbox click through to the source note: one
   * {@link TaskCommands.toggleAt} of `locator`, or nothing when no graph
   * is open. A failed write is reported as a failed operation, then rethrown.
   */
  toggleSnippetTask(
    notePath: string,
    task: { locator: TaskLocator; checked: boolean },
  ): Promise<void>
}

function sessionKey(session: GraphSession | null): string | null {
  return session === null ? null : `${session.generation}:${session.root}`
}

class TaskServiceImpl implements TaskService {
  readonly #deps: TaskServiceDeps
  readonly #reader: TaskReader
  #nextTaskId = 0
  #store = this.#createStore()
  readonly #state = new WritableStore<TaskStoreView>(this.#store.view(), isShallowEqual)
  #sessionKey: string | null = null
  /**
   * Aborts the reads of the graph that `#store` belongs to.
   */
  #reads = new AbortController()
  /**
   * The read of every note in flight.
   */
  #reading: Promise<void> | null = null
  /**
   * The index changed since the read in flight started: read once more after it.
   */
  #readAgain = false
  /**
   * The rows may be behind the index: the next subscriber reads them again.
   */
  #stale = true
  #completedHolds = 0
  #sources: Unlisten | null = null

  readonly commands: TaskCommands

  constructor(deps: TaskServiceDeps) {
    this.#deps = deps
    this.#reader = createTaskReader(deps)
    this.commands = new TaskCommands({
      ...deps,
      store: () => {
        this.#adoptSession()
        return this.#store
      },
      reader: this.#reader,
    })
  }

  readonly get = this.#state.get

  readonly subscribe = (listener: VoidFunction): Unlisten => {
    if (this.#sources === null) {
      this.#sources = this.#startSources()
      this.#adoptSession()
      if (this.#stale) {
        void this.#refresh()
      }
    }
    const unlisten = this.#state.subscribe(listener)
    return () => {
      unlisten()
      if (!this.#state.subscribed()) {
        this.#sources?.()
        this.#sources = null
      }
    }
  }

  /**
   * Read the open tasks again, and the completed tasks while
   * {@link TaskService.includeCompleted} holds them. A failed read is tried
   * again until it lands; the rows stay as they are meanwhile.
   */
  #refresh(): Promise<void> {
    this.#adoptSession()
    if (this.#sessionKey === null) {
      return Promise.resolve()
    }
    this.#stale = false
    if (this.#reading !== null) {
      this.#readAgain = true
      return this.#reading
    }
    const reading = this.#readAll().finally(() => {
      if (this.#reading === reading) {
        this.#reading = null
      }
    })
    this.#reading = reading
    return reading
  }

  includeCompleted(): Unlisten {
    this.#completedHolds += 1
    if (this.#completedHolds === 1) {
      void this.#refresh()
    }
    let held = true
    return () => {
      if (held) {
        held = false
        this.#completedHolds -= 1
      }
    }
  }

  resolveSnippetTask(tasks: readonly SnippetTask[], click: SnippetTaskClick): SnippetTask | null {
    const anchor = tasks[click.index]
    if (anchor === undefined || anchor.checked !== click.checked || anchor.text !== click.text) {
      this.#deps.progress.fail('Updating task', 'The note has changed — try again in a moment.')
      return null
    }
    return anchor
  }

  async toggleSnippetTask(
    notePath: string,
    task: { locator: TaskLocator; checked: boolean },
  ): Promise<void> {
    const { graphSession, progress } = this.#deps
    if (graphSession.get().session === null) {
      return
    }
    try {
      await this.commands.toggleAt(notePath, task.locator)
    } catch (cause) {
      progress.fail(task.checked ? 'Reopening task' : 'Completing task', errorMessage(cause))
      throw cause
    }
  }

  #createStore(): TaskStore {
    const store = new TaskStore(() => {
      this.#nextTaskId += 1
      return `task-${this.#nextTaskId}`
    })
    store.subscribe(() => {
      this.#publish()
    })
    return store
  }

  /**
   * Listen for committed note rows and graph switches. The returned function
   * stops listening and marks the rows stale, since later changes go unseen.
   */
  #startSources(): Unlisten {
    const unlisteners = [
      this.#deps.graphSession.subscribe(() => {
        if (this.#adoptSession()) {
          void this.#refresh()
        }
      }),
      this.#reader.subscribe(({ paths }) => {
        if (paths === null) {
          void this.#refresh()
        } else {
          void this.#readPaths(paths)
        }
      }),
    ]
    return () => {
      for (const unlisten of unlisteners) {
        unlisten()
      }
      this.#stale = true
    }
  }

  /**
   * Start an empty store for a graph that replaced the open one, and show
   * it; `true` when it did.
   */
  #adoptSession(): boolean {
    const { session } = this.#deps.graphSession.get()
    const key = sessionKey(session)
    if (key === this.#sessionKey) {
      return false
    }
    this.#sessionKey = key
    this.#reads.abort()
    this.#reads = new AbortController()
    this.#reading = null
    this.#readAgain = false
    this.#stale = true
    this.#store = this.#createStore()
    this.#publish()
    return true
  }

  /**
   * Read the tasks of every note into the store, again while the index
   * changed during the read. A note that the store keeps for its struck
   * task is read on its own.
   */
  async #readAll(): Promise<void> {
    const store = this.#store
    const { signal } = this.#reads
    do {
      this.#readAgain = false
      const completed = this.#completedHolds > 0
      const read = await this.#reader.readAll(completed ? null : false, signal)
      if (read === null) {
        return
      }
      const unread = store.landAll(read, completed)
      if (unread.length > 0) {
        await this.#readPathsInto(store, unread)
      }
    } while (this.#readAgain && !signal.aborted)
  }

  /**
   * Read every task of the notes at `paths` into the store.
   */
  async #readPaths(paths: readonly string[]): Promise<void> {
    this.#adoptSession()
    await this.#readPathsInto(this.#store, paths)
  }

  async #readPathsInto(store: TaskStore, paths: readonly string[]): Promise<void> {
    const read = await this.#reader.readPaths(paths, this.#reads.signal)
    if (read !== null) {
      store.landPaths(read, paths)
    }
  }

  #publish(): void {
    this.#state.set(this.#store.view())
  }
}

export function createTaskService(deps: TaskServiceDeps): TaskService {
  return new TaskServiceImpl(deps)
}
