import type { ClockService, TimerHandle } from '../ports/clock-service.ts'
import {
  requireGraphSession,
  type GraphRole,
  type GraphSession,
  type GraphSessionSource,
} from '../graph/graph-session.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import { NoteBusyError, type NoteDocumentService } from '../documents/note-document-service.ts'
import { errorMessage, AppError } from '../errors.ts'
import type { DatabaseService } from '../indexing/database-service.ts'
import type { IndexLifecycleService } from '../indexing/index-lifecycle-service.ts'
import { INDEX_WRITTEN_EVENT, listenNow, type IpcBridgeService } from '../ipc/ipc-service.ts'
import { decodeTaskBreadcrumbs } from '../indexing/indexed-note.ts'
import type { SnippetTask } from '../indexing/snippet-tasks.ts'
import type { Unlisten } from '../unlisten.ts'
import {
  applyTaskEdits,
  decodeTaskPath,
  renderTaskSnapshot,
  type TaskEdit,
  type TaskEditResult,
  type TaskLocator,
  type TaskSnapshot,
} from '../markdown/index.ts'
import { compareTasksByNote, type OpenTask } from './open-task.ts'
import {
  asCompleted,
  asOpen,
  withChecked,
  withEditedTask,
  withoutTasks,
  withRelocatedTasks,
  type TaskMoves,
} from './task-cache.ts'
import { getTaskKey, isSameTask } from './task-identity.ts'
import { createInsertedTaskRow, type InsertTaskTarget } from './task-insert-target.ts'
import { getScheduledMarkdown } from './task-schedule-content.ts'

export interface TaskServiceDeps {
  readonly database: DatabaseService
  readonly noteDocuments: NoteDocumentService
  readonly progress: ProgressPort
  readonly clock: ClockService
  readonly logger: LoggerService
  readonly graphSession: GraphSessionSource & { subscribe: (listener: () => void) => Unlisten }
  readonly indexLifecycle: IndexLifecycleService
  /**
   * Which window this webview is; only a note window follows {@link INDEX_WRITTEN_EVENT}.
   */
  readonly role: GraphRole
  readonly ipc: IpcBridgeService
}

/**
 * The Tasks view's rows: the open and completed tasks as last read, with the
 * pending optimistic writes applied.
 */
export interface TaskListState {
  /**
   * The open tasks; `undefined` until the first read lands.
   */
  readonly open: readonly OpenTask[] | undefined
  /**
   * The completed tasks; `undefined` until a read lands while
   * {@link TaskService.includeCompleted} holds the list.
   */
  readonly completed: readonly OpenTask[] | undefined
  /**
   * The last read of the open tasks failed.
   */
  readonly openFailed: boolean
  /**
   * The last read of the completed tasks failed.
   */
  readonly completedFailed: boolean
}

/**
 * A task's locator ({@link TaskLocator}) plus the note it lives in.
 */
export interface TaskRef extends TaskLocator {
  notePath: string
}

/**
 * A task write's {@link TaskEditResult} plus when the write landed.
 */
export interface TaskWriteResult extends TaskEditResult {
  /**
   * Epoch milliseconds read right after the write, for optimistic rows.
   */
  readonly updatedAt: number
}

/**
 * A write that added one task: the new row's address and where the note's other tasks went.
 */
export interface InsertedTask {
  /**
   * The new empty task, as the written note addresses it.
   */
  readonly created: TaskSnapshot
  /**
   * Where every pre-existing task of the note ended up after the write.
   */
  readonly moved: TaskEditResult['moved']
  /**
   * Epoch milliseconds read right after the write, for the optimistic row.
   */
  readonly updatedAt: number
}

export interface WriteTaskEditsOptions {
  /**
   * Treat a missing note as empty: the first task creates it (today's daily).
   */
  readonly createIfMissing?: boolean
}

/**
 * One change to the task `writeTask` addresses; `writeTask` supplies the locator.
 */
export type TaskAction =
  | { kind: 'toggle' }
  | { kind: 'setMarkdown'; markdown: string }
  | { kind: 'remove' }
  | { kind: 'toBullet' }

/**
 * A click on the `index`th checkbox of a rendered snippet, as the view reports it.
 */
export interface SnippetTaskClick {
  index: number
  checked: boolean
  text: string
}

/**
 * Reads, edits and adds round-checkbox tasks across notes (Plan 18), plus the
 * session's "recently completed" set.
 *
 * The recently-completed set is V1's middle state where a checked task keeps
 * showing (struck) in the list until you archive it. It's deliberately a
 * **view-only, ephemeral** set, not durable state: a checked task is already
 * `[x]` on disk, and "archived" only means "stop showing it in the active
 * list", which the markdown can't (and shouldn't) encode. So it resets on app
 * restart; it survives navigating away from Tasks and back (it lives on the
 * service, above any one screen mount). Tracking the session's completions —
 * rather than every `[x]` task — is what keeps a fresh launch clean: only what
 * you checked *this run* lingers struck; the whole historical pile stays
 * behind the "show archived" filter. It is scoped to a graph root: switching
 * graphs (whose task paths differ) yields an empty set rather than the
 * previous graph's rows.
 */
export interface TaskService {
  /**
   * Every open task across the graph, with note context, for the Tasks view.
   * Private notes' tasks are included because this is a local-only surface.
   */
  getOpenTasks(): Promise<OpenTask[]>
  /**
   * Completed tasks across the graph, most-recently-edited note first — the
   * Tasks view's "show archived" surface.
   */
  getCompletedTasks(): Promise<OpenTask[]>
  /**
   * The open graph's task rows. The same object is returned until the rows,
   * a read failure, or the open graph change.
   */
  getState: () => TaskListState
  /**
   * Call `listener` whenever {@link TaskService.getState} changes. The first
   * subscription reads the open tasks; while any listener is subscribed, an
   * index change re-reads them.
   */
  subscribe: (listener: () => void) => Unlisten
  /**
   * Re-read the open tasks, and the completed tasks while
   * {@link TaskService.includeCompleted} holds them, through the database.
   */
  refresh(): Promise<void>
  /**
   * Read the completed tasks too, and keep them fresh, until the returned
   * function runs.
   */
  includeCompleted(): Unlisten
  /**
   * Apply `actions` to one task in one write: toggle its checkbox, replace its
   * Markdown (the first paragraph without the marker), remove it (nested items
   * move up), or demote it to a plain bullet so it leaves the Tasks projection
   * but stays in the note. Several actions land together, so an inline edit
   * and the toggle or convert that ends it are one write; every action
   * addresses the task as the index knew it.
   */
  writeTask(task: TaskRef, actions: readonly TaskAction[]): Promise<TaskWriteResult>
  /**
   * Continue entry from a grouped task: resolve the current draft and add a new
   * empty task at the end of the same parent item, or of the task's own list
   * under a heading, in one write. Changed content replaces the anchor's
   * Markdown; cleared content removes the anchor. The result addresses the new
   * row and every moved row in the written note, so the Tasks view can select
   * the new task and re-key cached rows before reindexing catches up.
   */
  continueTaskInContext(task: TaskRef, content: string | null): Promise<InsertedTask>
  /**
   * Insert a new empty `+ [ ]` task into `notePath`'s `## Tasks` section
   * (Return-to-add), creating the section after the note's last content when
   * it has none, and return the new row's address plus where the note's other
   * tasks moved. A missing note (today's daily not yet created) starts empty.
   */
  insertTask(notePath: string): Promise<InsertedTask>
  /**
   * Check `tasks` one write at a time. The rows leave the open list, join the
   * completed list as checked, and stay in the recently-completed set before
   * the first write. A failure re-reads the rows, drops `tasks` from the
   * recently-completed set, and rethrows.
   */
  completeTasks(tasks: readonly OpenTask[]): Promise<void>
  /**
   * Uncheck `tasks` one write at a time. The rows return to the open list and
   * leave the completed list and the recently-completed set before the first
   * write. A failure re-reads the rows and rethrows.
   */
  reopenTasks(tasks: readonly OpenTask[]): Promise<void>
  /**
   * Remove `tasks` from their notes one write at a time. The rows leave both
   * lists and the recently-completed set before the first write. A failure
   * re-reads the rows, keeps the checked ones struck again, and rethrows.
   */
  deleteTasks(tasks: readonly OpenTask[]): Promise<void>
  /**
   * Replace one task's Markdown. The rows show the new text before the write;
   * a failure restores the rows as they were and rethrows.
   */
  editTask(task: OpenTask, content: string): Promise<void>
  /**
   * Set each task's due date to `isoDate`, or clear it for `null`, one write
   * at a time. The rows show the new date link before the first write; a
   * failure re-reads the rows and rethrows.
   */
  scheduleTasks(tasks: readonly OpenTask[], isoDate: string | null): Promise<void>
  /**
   * Turn `tasks` into plain bullets one write at a time, with the optimistic
   * rows and the failure handling of {@link TaskService.deleteTasks}.
   */
  convertTasks(tasks: readonly OpenTask[]): Promise<void>
  /**
   * Replace one task's Markdown and turn it into a plain bullet in one write.
   * The row leaves both lists and the recently-completed set before the
   * write; a failure restores the rows, keeps a checked task struck again,
   * and rethrows.
   */
  editAndConvertTask(task: OpenTask, content: string): Promise<void>
  /**
   * Toggle one task's checkbox, first replacing its Markdown unless `content`
   * is `null`, in one write. The row moves between the lists and the
   * recently-completed set before the write; a failure restores the rows and
   * the set, and rethrows.
   */
  editAndToggleTask(task: OpenTask, content: string | null): Promise<void>
  /**
   * Add an empty task to `target`'s note ({@link TaskService.insertTask}) and
   * return its row, already in the open list. A failure re-reads the rows and
   * rethrows.
   */
  addTask(target: InsertTaskTarget): Promise<OpenTask>
  /**
   * Resolve `task`'s draft and add an empty task after it
   * ({@link TaskService.continueTaskInContext}), and return the new row,
   * already in the open list. The anchor row shows its draft before the
   * write; a failure restores the rows and rethrows.
   */
  addTaskAfter(task: OpenTask, content: string | null): Promise<OpenTask>
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
   * {@link TaskService.writeTask} toggle of `locator`, or nothing when no graph
   * is open. A failed write is reported as a failed operation, then rethrown.
   */
  toggleSnippetTask(
    notePath: string,
    task: { locator: TaskLocator; checked: boolean },
  ): Promise<void>
  /**
   * Keep `completed` showing struck (checked) in the active list until archived.
   * Stored as a fresh checked copy, deduped by {@link getTaskKey}. `checked` is
   * set to match disk: these rows outlive the reindex, and the write-back guards
   * on it, so a stale `false` would later fail a reopen/edit/delete.
   */
  markRecentlyCompleted(root: string | null, completed: readonly OpenTask[]): void
  /**
   * Drop these keys — a completion rolled back, or the task was deleted.
   */
  forgetRecentlyCompleted(root: string | null, keys: readonly string[]): void
  /**
   * Whether a task is currently being kept visible by the session's struck set.
   */
  hasRecentlyCompleted(root: string | null, key: string): boolean
  /**
   * Apply a note write's task moves to the session's struck rows. Unlike the
   * query caches, this set is not rebuilt by an open-task refetch, so moved
   * completed rows must be re-keyed explicitly.
   */
  relocateRecentlyCompleted(root: string | null, notePath: string, moved: TaskMoves): void
  /**
   * Reconcile the struck set against a fresh open-tasks read, dropping every
   * struck copy whose task was reopened at its source note ({@link
   * withoutReopenedTasks}) — so `hasRecentlyCompleted` and the Archive count
   * agree with what the surfaces render.
   */
  reconcileRecentlyCompleted(root: string | null, open: readonly OpenTask[]): void
  /**
   * Archive: stop showing the session's completed tasks (they stay `[x]` on disk).
   */
  archiveRecentlyCompleted(root: string | null): void
  /**
   * The session's struck rows for `root`; a stable empty list for any other graph.
   */
  getRecentlyCompleted(root: string | null): readonly OpenTask[]
  /**
   * Calls `listener` whenever the recently-completed set changes.
   */
  subscribeRecentlyCompleted: (listener: () => void) => () => void
}

/**
 * The struck rows not superseded by a live open row — the pure core of the
 * reconciliation, shared by the store prune
 * ({@link TaskService.reconcileRecentlyCompleted}) and the render-time view.
 * A struck task the index reports open again with a **newer** `updatedAt` was
 * reopened at the source note — its file was rewritten and reindexed since we
 * completed it — so the struck copy is dropped and the live open row shows
 * instead of a stale `[x]` shadow (whose reopen write-back would fail: the
 * `[x]` line is no longer in the note). An open row with an *unchanged*
 * `updatedAt` is the pre-completion index state — a refetch racing the
 * completion's reindex — and keeps its shadow, so a just-checked row can't
 * flicker back to open. Returns the input array itself when nothing is
 * dropped, so callers can compare by reference.
 */
export function withoutReopenedTasks(
  struck: readonly OpenTask[],
  open: readonly OpenTask[],
): readonly OpenTask[] {
  if (struck.length === 0 || open.length === 0) {
    return struck
  }
  const liveByKey = new Map(open.map((row) => [getTaskKey(row), row]))
  const next = struck.filter((task) => {
    const live = liveByKey.get(getTaskKey(task))
    return live === undefined || live.updatedAt <= task.updatedAt
  })
  return next.length === struck.length ? struck : next
}

interface TaskRecord {
  notePath: string
  astPath: string
  markdown: string
  breadcrumbs: string
  checked: number
  noteTitle: string
  dailyDate: string | null
  isPinned: number
  pinnedOrder: number | null
  updatedAt: number
}

/**
 * Only the locator goes to the core edit: the note path merely picks the owner.
 */
function toLocator(task: TaskRef): TaskLocator {
  return { astPath: task.astPath, markdown: task.markdown, checked: task.checked }
}

function requireInserted(result: TaskEditResult): TaskSnapshot {
  const created = result.inserted[0]
  if (created === undefined) {
    throw new Error('The new task was not written.')
  }
  return created
}

const EMPTY: readonly OpenTask[] = []

const EMPTY_STATE: TaskListState = {
  open: undefined,
  completed: undefined,
  openFailed: false,
  completedFailed: false,
}

/**
 * Spacing between index-change re-reads while the index applies batch after batch.
 */
const REFRESH_THROTTLE_MS = 3_000

/**
 * Updates a task list in place; returning `undefined` leaves the list as it is.
 */
type TaskListPatch = (rows: readonly OpenTask[] | undefined) => readonly OpenTask[] | undefined

/**
 * Both task lists as they were before an optimistic write.
 */
interface TaskListSnapshot {
  /**
   * The session key of the graph the snapshot was taken in.
   */
  readonly key: string | null
  readonly open: readonly OpenTask[] | undefined
  readonly completed: readonly OpenTask[] | undefined
}

/**
 * One task list and the state of its reads.
 */
interface TaskListSlot {
  rows: readonly OpenTask[] | undefined
  failed: boolean
  /**
   * The rows may be behind the index: the next subscriber reads them again.
   */
  stale: boolean
  loading: boolean
  /**
   * Bumped by each read and each cancel; a read lands only while it holds the latest value.
   */
  read: number
}

function emptySlot(): TaskListSlot {
  return { rows: undefined, failed: false, stale: true, loading: false, read: 0 }
}

function sessionKey(session: GraphSession | null): string | null {
  return session === null ? null : `${session.generation}:${session.root}`
}

function keysOf(tasks: readonly OpenTask[]): string[] {
  return tasks.map(getTaskKey)
}

class TaskServiceImpl implements TaskService {
  readonly #deps: TaskServiceDeps
  readonly #listeners = new Set<() => void>()
  #graphRoot: string | null = null
  #struck: readonly OpenTask[] = EMPTY
  readonly #stateListeners = new Set<() => void>()
  #state: TaskListState = EMPTY_STATE
  #sessionKey: string | null = null
  #open: TaskListSlot = emptySlot()
  #completed: TaskListSlot = emptySlot()
  #completedHolds = 0
  #attached = false
  #lastRefreshAt = -Infinity
  #trailingRefresh: TimerHandle | null = null

  constructor(deps: TaskServiceDeps) {
    this.#deps = deps
  }

  async getOpenTasks(): Promise<OpenTask[]> {
    const rows = await this.#taskRowsQuery().where('tasks.checked', '=', 0).execute()
    return this.#toTaskRows(rows).sort(compareTasksByNote)
  }

  async getCompletedTasks(): Promise<OpenTask[]> {
    const rows = await this.#taskRowsQuery().where('tasks.checked', '=', 1).execute()
    return this.#toTaskRows(rows).sort(
      (left, right) => right.updatedAt - left.updatedAt || compareTasksByNote(left, right),
    )
  }

  readonly getState = (): TaskListState => {
    this.#adoptSession()
    return this.#state
  }

  readonly subscribe = (listener: () => void): Unlisten => {
    this.#attach()
    this.#stateListeners.add(listener)
    this.#syncSession()
    this.#loadStale()
    return () => {
      this.#stateListeners.delete(listener)
    }
  }

  async refresh(): Promise<void> {
    this.#attach()
    this.#syncSession()
    const reads = [this.#readOpen()]
    if (this.#completedHolds > 0) {
      reads.push(this.#readCompleted())
    } else {
      this.#completed.stale = true
    }
    await Promise.all(reads)
  }

  includeCompleted(): Unlisten {
    this.#attach()
    this.#completedHolds += 1
    this.#syncSession()
    this.#loadStale()
    let held = true
    return () => {
      if (held) {
        held = false
        this.#completedHolds -= 1
      }
    }
  }

  async writeTask(task: TaskRef, actions: readonly TaskAction[]): Promise<TaskWriteResult> {
    return await this.#writeOne(
      requireGraphSession(this.#deps.graphSession).generation,
      task,
      actions,
    )
  }

  async continueTaskInContext(task: TaskRef, content: string | null): Promise<InsertedTask> {
    const { generation } = requireGraphSession(this.#deps.graphSession)
    const locator = toLocator(task)
    const edits: TaskEdit[] = [
      { kind: 'insert', at: { kind: 'contextEnd', task: locator }, markdown: '' },
    ]
    if (content === '') {
      edits.push({ kind: 'remove', task: locator })
    } else if (content !== null) {
      edits.push({ kind: 'setMarkdown', task: locator, markdown: content })
    }
    const result = await this.#writeEdits(generation, task.notePath, edits)
    return {
      created: requireInserted(result),
      moved: result.moved,
      updatedAt: result.updatedAt,
    }
  }

  async insertTask(notePath: string): Promise<InsertedTask> {
    const { generation } = requireGraphSession(this.#deps.graphSession)
    const result = await this.#writeEdits(
      generation,
      notePath,
      [{ kind: 'insert', at: { kind: 'tasksSection' }, markdown: '' }],
      { createIfMissing: true },
    )
    return {
      created: requireInserted(result),
      moved: result.moved,
      updatedAt: result.updatedAt,
    }
  }

  async completeTasks(tasks: readonly OpenTask[]): Promise<void> {
    const session = this.#begin()
    const { root } = session
    this.#snapshot()
    this.#patch(
      (rows) => withoutTasks(rows, tasks),
      (rows) => asCompleted(rows, tasks),
    )
    this.markRecentlyCompleted(root, tasks)
    try {
      await this.#writeEach(session, tasks, () => [{ kind: 'toggle' }])
    } catch (cause) {
      // Earlier writes of the batch may have landed: re-read rather than restore.
      this.#invalidate()
      this.forgetRecentlyCompleted(root, keysOf(tasks))
      throw cause
    }
  }

  async reopenTasks(tasks: readonly OpenTask[]): Promise<void> {
    const session = this.#begin()
    this.#snapshot()
    this.#patch(
      (rows) => asOpen(rows, tasks),
      (rows) => withoutTasks(rows, tasks),
    )
    this.forgetRecentlyCompleted(session.root, keysOf(tasks))
    try {
      await this.#writeEach(session, tasks, () => [{ kind: 'toggle' }])
    } catch (cause) {
      this.#invalidate()
      throw cause
    }
  }

  async deleteTasks(tasks: readonly OpenTask[]): Promise<void> {
    await this.#removeEach(tasks, 'remove')
  }

  async editTask(task: OpenTask, content: string): Promise<void> {
    this.#begin()
    const snapshot = this.#snapshot()
    const patch: TaskListPatch = (rows) => withEditedTask(rows, task, content)
    this.#patch(patch, patch)
    try {
      await this.writeTask(task, [{ kind: 'setMarkdown', markdown: content }])
    } catch (cause) {
      this.#restore(snapshot)
      throw cause
    }
  }

  async scheduleTasks(tasks: readonly OpenTask[], isoDate: string | null): Promise<void> {
    const session = this.#begin()
    this.#snapshot()
    // The row keeps its bucket until the reindex re-derives the due date.
    const patch: TaskListPatch = (rows) =>
      tasks.reduce(
        (acc, task) => withEditedTask(acc, task, getScheduledMarkdown(task, isoDate)),
        rows,
      )
    this.#patch(patch, patch)
    try {
      await this.#writeEach(session, tasks, (task) => [
        { kind: 'setMarkdown', markdown: getScheduledMarkdown(task, isoDate) },
      ])
    } catch (cause) {
      this.#invalidate()
      throw cause
    }
  }

  async convertTasks(tasks: readonly OpenTask[]): Promise<void> {
    await this.#removeEach(tasks, 'toBullet')
  }

  async editAndConvertTask(task: OpenTask, content: string): Promise<void> {
    const session = this.#begin()
    const { root } = session
    const snapshot = this.#snapshot()
    this.#patch(
      (rows) => withoutTasks(rows, [task]),
      (rows) => withoutTasks(rows, [task]),
    )
    this.forgetRecentlyCompleted(root, [getTaskKey(task)])
    try {
      const result = await this.writeTask(task, [
        { kind: 'setMarkdown', markdown: content },
        { kind: 'toBullet' },
      ])
      this.#relocate(session, task.notePath, result.moved)
    } catch (cause) {
      this.#restore(snapshot)
      if (task.checked) {
        this.markRecentlyCompleted(root, [task])
      }
      throw cause
    }
  }

  async editAndToggleTask(task: OpenTask, content: string | null): Promise<void> {
    const { root } = this.#begin()
    const snapshot = this.#snapshot()
    const edited = content === null ? task : (withEditedTask([task], task, content)?.[0] ?? task)
    const wasRecentlyCompleted = this.hasRecentlyCompleted(root, getTaskKey(task))
    if (task.checked) {
      this.#patch(
        (rows) => asOpen(rows, [edited]),
        (rows) => withoutTasks(rows, [task]),
      )
      this.forgetRecentlyCompleted(root, [getTaskKey(task)])
    } else {
      // The struck row shows the edited text, in the completed list and the recently-completed set.
      this.#patch(
        (rows) => withoutTasks(rows, [task]),
        (rows) => asCompleted(rows, [edited]),
      )
      this.markRecentlyCompleted(root, [edited])
    }
    try {
      await this.writeTask(
        task,
        content === null
          ? [{ kind: 'toggle' }]
          : [{ kind: 'setMarkdown', markdown: content }, { kind: 'toggle' }],
      )
    } catch (cause) {
      // One write: nothing landed, so the rows before the write are the truth.
      this.#restore(snapshot)
      if (task.checked && wasRecentlyCompleted) {
        this.markRecentlyCompleted(root, [task])
      } else if (!task.checked) {
        this.forgetRecentlyCompleted(root, [getTaskKey(task)])
      }
      throw cause
    }
  }

  async addTask(target: InsertTaskTarget): Promise<OpenTask> {
    const session = this.#begin()
    let result: InsertedTask
    try {
      result = await this.insertTask(target.notePath)
    } catch (cause) {
      this.#invalidate()
      throw cause
    }
    return this.#addInserted(session, target, result)
  }

  async addTaskAfter(task: OpenTask, content: string | null): Promise<OpenTask> {
    const session = this.#begin()
    const snapshot = this.#snapshot()
    // The anchor resolves in the same write: a cleared row leaves, an edited one shows its text.
    const patch: TaskListPatch = (rows) =>
      content === ''
        ? withoutTasks(rows, [task])
        : content === null
          ? rows
          : withEditedTask(rows, task, content)
    this.#patch(patch, patch)
    let result: InsertedTask
    try {
      result = await this.continueTaskInContext(task, content)
    } catch (cause) {
      this.#restore(snapshot)
      throw cause
    }
    return this.#addInserted(session, task, result)
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
    if (this.#deps.graphSession.getState().session === null) {
      return
    }
    try {
      await this.writeTask({ notePath, ...task.locator }, [{ kind: 'toggle' }])
    } catch (cause) {
      this.#deps.progress.fail(
        task.checked ? 'Reopening task' : 'Completing task',
        errorMessage(cause),
      )
      throw cause
    }
  }

  markRecentlyCompleted(root: string | null, completed: readonly OpenTask[]): void {
    if (completed.length === 0) {
      return
    }
    this.#adopt(root)
    const byKey = new Map(this.#struck.map((task) => [getTaskKey(task), task]))
    for (const task of completed) {
      byKey.set(getTaskKey(task), withChecked(task, true))
    }
    this.#struck = [...byKey.values()]
    this.#emit()
  }

  forgetRecentlyCompleted(root: string | null, keys: readonly string[]): void {
    if (root !== this.#graphRoot || keys.length === 0) {
      return
    }
    const drop = new Set(keys)
    const next = this.#struck.filter((task) => !drop.has(getTaskKey(task)))
    if (next.length !== this.#struck.length) {
      this.#struck = next
      this.#emit()
    }
  }

  hasRecentlyCompleted(root: string | null, key: string): boolean {
    return root === this.#graphRoot && this.#struck.some((task) => getTaskKey(task) === key)
  }

  relocateRecentlyCompleted(root: string | null, notePath: string, moved: TaskMoves): void {
    if (root !== this.#graphRoot || moved.length === 0) {
      return
    }
    const next =
      withRelocatedTasks({ logger: this.#deps.logger }, this.#struck, notePath, moved) ?? []
    if (next !== this.#struck) {
      this.#struck = next
      this.#emit()
    }
  }

  reconcileRecentlyCompleted(root: string | null, open: readonly OpenTask[]): void {
    if (root !== this.#graphRoot) {
      return
    }
    const next = withoutReopenedTasks(this.#struck, open)
    if (next !== this.#struck) {
      this.#struck = next
      this.#emit()
    }
  }

  archiveRecentlyCompleted(root: string | null): void {
    this.#adopt(root)
    if (this.#struck.length > 0) {
      this.#struck = EMPTY
      this.#emit()
    }
  }

  getRecentlyCompleted(root: string | null): readonly OpenTask[] {
    return root === this.#graphRoot ? this.#struck : EMPTY
  }

  readonly subscribeRecentlyCompleted = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #taskRowsQuery() {
    return this.#deps.database.db
      .selectFrom('tasks')
      .innerJoin('notes', 'notes.path', 'tasks.notePath')
      .where('notes.kind', '!=', 'template')
      .select([
        'tasks.notePath',
        'tasks.astPath',
        'tasks.markdown',
        'tasks.breadcrumbs',
        'tasks.checked',
        'notes.title as noteTitle',
        'notes.dailyDate',
        'notes.isPinned',
        'notes.pinnedOrder',
        'notes.updatedAt',
      ])
  }

  /**
   * Map stored rows to their domain shape. A row whose address or breadcrumbs
   * do not decode is skipped and reported instead of failing the whole read: the
   * projection is rebuilt from Markdown, so such a row is a bug, not data.
   */
  #toTaskRows(rows: readonly TaskRecord[]): OpenTask[] {
    const tasks: OpenTask[] = []
    for (const row of rows) {
      const { astPath, markdown, breadcrumbs, checked, isPinned, ...rest } = row
      try {
        tasks.push({
          ...rest,
          ...renderTaskSnapshot({
            astPath: decodeTaskPath(astPath),
            markdown,
            breadcrumbs: decodeTaskBreadcrumbs(breadcrumbs),
            checked: checked !== 0,
          }),
          isPinned: isPinned !== 0,
        })
      } catch (cause) {
        this.#deps.logger.error(
          `tasks: skipping an unreadable row in ${row.notePath} (${astPath})`,
          cause,
        )
      }
    }
    return tasks
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }

  /**
   * Listen for index changes and graph switches, once, on first use.
   */
  #attach(): void {
    if (this.#attached) {
      return
    }
    this.#attached = true
    const { graphSession, indexLifecycle, role, ipc, logger } = this.#deps
    graphSession.subscribe(() => {
      if (this.#adoptSession()) {
        this.#publish()
        this.#loadStale()
      }
    })
    indexLifecycle.onApplied(() => this.#throttledInvalidate())
    // A manual rebuild skips the watcher pipeline and its applied events.
    indexLifecycle.onReconciled((event) => {
      if (event.source !== 'sync') {
        this.#invalidate()
      }
    })
    if (role !== 'main') {
      // A note window runs no indexer; the main window's committed writes reach it here.
      listenNow(
        () => ipc.listen(INDEX_WRITTEN_EVENT, () => this.#throttledInvalidate()),
        (cause) => {
          logger.error(`${INDEX_WRITTEN_EVENT} listener failed:`, cause)
        },
      )
    }
  }

  /**
   * Drop the rows of a graph that is no longer open; `true` when they were dropped.
   */
  #adoptSession(): boolean {
    const key = sessionKey(this.#deps.graphSession.getState().session)
    if (key === this.#sessionKey) {
      return false
    }
    this.#sessionKey = key
    this.#open.read += 1
    this.#completed.read += 1
    this.#open = emptySlot()
    this.#completed = emptySlot()
    this.#state = EMPTY_STATE
    return true
  }

  #syncSession(): void {
    if (this.#adoptSession()) {
      this.#publish()
    }
  }

  /**
   * Read each held list whose rows may be behind the index.
   */
  #loadStale(): void {
    if (this.#stateListeners.size > 0 && this.#open.stale) {
      void this.#readOpen()
    }
    if (this.#completedHolds > 0 && this.#completed.stale) {
      void this.#readCompleted()
    }
  }

  #readOpen(): Promise<void> {
    return this.#read(this.#open, () => this.getOpenTasks())
  }

  #readCompleted(): Promise<void> {
    return this.#read(this.#completed, () => this.getCompletedTasks())
  }

  async #read(slot: TaskListSlot, read: () => Promise<OpenTask[]>): Promise<void> {
    if (this.#sessionKey === null) {
      return
    }
    slot.read += 1
    const token = slot.read
    slot.stale = false
    slot.loading = true
    let rows: OpenTask[] | undefined
    try {
      rows = await read()
    } catch {
      rows = undefined
    }
    if (slot.read !== token) {
      return
    }
    slot.loading = false
    if (rows === undefined) {
      slot.failed = true
    } else {
      slot.rows = rows
      slot.failed = false
    }
    this.#publish()
  }

  /**
   * Re-read the rows when a screen shows them, else mark them stale for the next one.
   */
  #invalidate(): void {
    if (this.#stateListeners.size > 0) {
      void this.refresh()
    } else {
      this.#open.stale = true
      this.#completed.stale = true
    }
  }

  /**
   * {@link TaskServiceImpl.#invalidate}, at most once per {@link REFRESH_THROTTLE_MS}:
   * an isolated change re-reads at once, and a burst ends with one trailing re-read.
   */
  #throttledInvalidate(): void {
    const { clock } = this.#deps
    const elapsed = clock.monotonicNow() - this.#lastRefreshAt
    if (elapsed >= REFRESH_THROTTLE_MS) {
      this.#lastRefreshAt = clock.monotonicNow()
      this.#invalidate()
      return
    }
    if (this.#trailingRefresh !== null) {
      return
    }
    this.#trailingRefresh = clock.setTimeout(() => {
      this.#trailingRefresh = null
      this.#lastRefreshAt = clock.monotonicNow()
      this.#invalidate()
    }, REFRESH_THROTTLE_MS - elapsed)
  }

  #publish(): void {
    this.#state = {
      open: this.#open.rows,
      completed: this.#completed.rows,
      openFailed: this.#open.failed,
      completedFailed: this.#completed.failed,
    }
    for (const listener of this.#stateListeners) {
      listener()
    }
  }

  /**
   * The open graph at the start of a write, with its rows adopted.
   */
  #begin(): GraphSession {
    const session = requireGraphSession(this.#deps.graphSession)
    this.#syncSession()
    return session
  }

  /**
   * Cancel the reads in flight, so they cannot overwrite an optimistic patch,
   * and capture both lists for a rollback.
   */
  #snapshot(): TaskListSnapshot {
    for (const slot of [this.#open, this.#completed]) {
      if (slot.loading) {
        slot.read += 1
        slot.loading = false
        slot.stale = true
      }
    }
    return { key: this.#sessionKey, open: this.#open.rows, completed: this.#completed.rows }
  }

  /**
   * Put back the rows of `snapshot`, unless another graph opened since it was taken.
   */
  #restore(snapshot: TaskListSnapshot): void {
    if (snapshot.key !== this.#currentKey()) {
      return
    }
    this.#setRows(this.#open, snapshot.open)
    this.#setRows(this.#completed, snapshot.completed)
    this.#publish()
  }

  /**
   * Rewrite both lists at once. A list that comes back `undefined` is left as it is.
   */
  #patch(open: TaskListPatch, completed: TaskListPatch): void {
    this.#setRows(this.#open, open(this.#open.rows))
    this.#setRows(this.#completed, completed(this.#completed.rows))
    this.#publish()
  }

  #setRows(slot: TaskListSlot, rows: readonly OpenTask[] | undefined): void {
    if (rows !== undefined) {
      slot.rows = rows
      slot.failed = false
      slot.stale = false
    }
  }

  /**
   * The session key of the open graph.
   */
  #currentKey(): string | null {
    return sessionKey(this.#deps.graphSession.getState().session)
  }

  /**
   * Re-key the rows and the recently-completed set from a write's `moved` map,
   * unless another graph opened since `session` began the write.
   */
  #relocate(session: GraphSession, notePath: string, moved: TaskMoves): void {
    if (sessionKey(session) !== this.#currentKey()) {
      return
    }
    const { logger } = this.#deps
    const relocate: TaskListPatch = (rows) => withRelocatedTasks({ logger }, rows, notePath, moved)
    this.#patch(relocate, relocate)
    this.relocateRecentlyCompleted(session.root, notePath, moved)
  }

  /**
   * Write `tasks` one at a time, re-keying the rows from each write before the next.
   */
  async #writeEach(
    session: GraphSession,
    tasks: readonly OpenTask[],
    actionsFor: (task: OpenTask) => readonly TaskAction[],
  ): Promise<void> {
    const { signal } = session
    let pending: readonly OpenTask[] = tasks
    for (let task = pending[0]; task !== undefined; task = pending[0]) {
      // After the batch's graph closes or switches, a write would land in the next graph.
      if (signal.aborted) {
        throw new AppError('noGraph', 'No graph is open.')
      }
      const result = await this.writeTask(task, actionsFor(task))
      this.#relocate(session, task.notePath, result.moved)
      const rest: readonly OpenTask[] = pending.slice(1)
      pending =
        withRelocatedTasks({ logger: this.#deps.logger }, rest, task.notePath, result.moved) ?? []
    }
  }

  /**
   * Delete or convert `tasks`: the rows leave both lists outright.
   */
  async #removeEach(tasks: readonly OpenTask[], kind: 'remove' | 'toBullet'): Promise<void> {
    const session = this.#begin()
    const { root } = session
    this.#snapshot()
    this.#patch(
      (rows) => withoutTasks(rows, tasks),
      (rows) => withoutTasks(rows, tasks),
    )
    this.forgetRecentlyCompleted(root, keysOf(tasks))
    try {
      await this.#writeEach(session, tasks, () => [{ kind }])
    } catch (cause) {
      this.#invalidate()
      // A checked task is still `[x]` on disk: keep it struck, or it would vanish from the list.
      this.markRecentlyCompleted(
        root,
        tasks.filter((task) => task.checked),
      )
      throw cause
    }
  }

  /**
   * Re-key the rows a task insert moved, then add the new task's row to the open
   * list; the rows stay as they are when another graph opened since `session`.
   */
  #addInserted(session: GraphSession, target: InsertTaskTarget, result: InsertedTask): OpenTask {
    const created = createInsertedTaskRow(target, result.created, result.updatedAt)
    if (sessionKey(session) !== this.#currentKey()) {
      return created
    }
    this.#relocate(session, target.notePath, result.moved)
    this.#patch(
      (rows) => [...(rows ?? []).filter((row) => !isSameTask(row, created)), created],
      (rows) => rows?.filter((row) => !isSameTask(row, created)),
    )
    return created
  }

  /**
   * Switch the active graph, discarding any other graph's set.
   */
  #adopt(root: string | null): void {
    if (root !== this.#graphRoot) {
      this.#graphRoot = root
      this.#struck = EMPTY
    }
  }

  async #writeEdits(
    generation: number,
    notePath: string,
    edits: readonly TaskEdit[],
    options: WriteTaskEditsOptions = {},
  ): Promise<TaskWriteResult> {
    const { noteDocuments, clock, logger } = this.#deps
    let result: TaskEditResult | undefined
    await noteDocuments.commitSourceEdit(
      notePath,
      (source) => {
        result = applyTaskEdits({ logger }, source, edits)
        return result.source
      },
      { generation, createIfMissing: options.createIfMissing === true },
    )
    if (result === undefined) {
      throw new NoteBusyError('This note can’t be updated right now — try again in a moment.')
    }
    return { ...result, updatedAt: clock.now() }
  }

  #writeOne(
    generation: number,
    task: TaskRef,
    actions: readonly TaskAction[],
  ): Promise<TaskWriteResult> {
    const locator = toLocator(task)
    return this.#writeEdits(
      generation,
      task.notePath,
      actions.map((action) => ({ ...action, task: locator })),
    )
  }
}

export function createTaskService(deps: TaskServiceDeps): TaskService {
  return new TaskServiceImpl(deps)
}
