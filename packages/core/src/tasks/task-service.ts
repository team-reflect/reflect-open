import { isShallowEqual } from '@ocavue/utils'
import type { ClockService, TimerHandle } from '../ports/clock-service.ts'
import { requireGraphSession, type GraphRole, type GraphSession } from '../graph/graph-session.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import type { NoteDocumentService } from '../documents/note-document-service.ts'
import { AppError } from '../errors.ts'
import type { DatabaseService } from '../indexing/database-service.ts'
import type { IndexLifecycleService } from '../indexing/index-lifecycle-service.ts'
import { INDEX_COMMITTED_EVENT, listenNow, type IpcBridgeService } from '../ipc/ipc-service.ts'
import type { SnippetTask } from '../indexing/snippet-tasks.ts'
import { WritableStore, type Store } from '../store.ts'
import type { Unlisten } from '../unlisten.ts'
import { splitFrontmatter } from '../markdown/frontmatter.ts'
import {
  applyTaskEdits,
  isSameTaskPath,
  projectTasks,
  type TaskEdit,
  type TaskEditResult,
  type TaskLocator,
  type TaskSnapshot,
} from '../markdown/index.ts'
import type { OpenTask } from './open-task.ts'
import {
  resolveSnippetTask,
  toggleSnippetTask,
  type SnippetTaskClick,
} from './snippet-task-toggle.ts'
import { withChecked, withRelocatedTasks, type TaskMoves } from './task-cache.ts'
import { NoteEditError } from './task-errors.ts'
import { getTaskKey } from './task-identity.ts'
import { createInsertedTaskRow, type InsertTaskTarget } from './task-insert-target.ts'
import { applyTaskOp, type TaskItemOp, type TaskOp } from './task-ops.ts'
import { createTaskReader, type TaskReader } from './task-reader.ts'
import { getScheduledMarkdown } from './task-schedule-content.ts'
import { TaskStore, type PendingWrite, type TaskCommit, type TaskStoreView } from './task-store.ts'

export interface TaskServiceDeps {
  readonly database: DatabaseService
  readonly noteDocuments: NoteDocumentService
  readonly progress: ProgressPort
  readonly clock: ClockService
  readonly logger: LoggerService
  readonly graphSession: Store<{ readonly session: GraphSession | null }>
  readonly indexLifecycle: IndexLifecycleService
  /**
   * Which window this webview is; only a note window follows {@link INDEX_COMMITTED_EVENT}.
   */
  readonly role: GraphRole
  readonly ipc: IpcBridgeService
}

/**
 * The Tasks view's rows: the tasks of the notes as last read or written, with
 * the writes in flight applied.
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
}

/**
 * The session's recently-completed tasks and the graph they belong to.
 */
export interface RecentlyCompleted {
  /**
   * The graph root of {@link RecentlyCompleted.tasks}.
   */
  readonly root: string | null
  /**
   * The struck rows, each checked.
   */
  readonly tasks: readonly OpenTask[]
}

/**
 * A task's locator ({@link TaskLocator}) plus the note it lives in.
 */
export interface TaskRef extends TaskLocator {
  notePath: string
}

/**
 * What a task write left in its note.
 */
export interface TaskWriteResult extends TaskEditResult {
  /**
   * The hash of the note text the write left.
   */
  readonly revision: string
  /**
   * Every round task of the note text the write left, in document order.
   */
  readonly tasks: readonly TaskSnapshot[]
  /**
   * Whether the note holds another text than `source`: the write merged with
   * a newer text. `moved` and `inserted` then describe `source` only.
   */
  readonly merged: boolean
  /**
   * The seq of an index commit that holds the note text, when one is known.
   */
  readonly indexSeq: number | null
  /**
   * Epoch milliseconds read right after the write, to order the rows of the note.
   */
  readonly updatedAt: number
}

/**
 * A write that added one task.
 */
export interface InsertedTask extends TaskWriteResult {
  /**
   * The new task, as the written note addresses it.
   */
  readonly created: TaskSnapshot
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
export interface TaskService extends Store<TaskListState> {
  /**
   * The open graph's task rows. Private notes' tasks are included because
   * this is a local-only surface. The same object is returned until the rows
   * or the open graph change.
   */
  get: () => TaskListState
  /**
   * Call `listener` whenever {@link TaskService.get} changes. The first
   * subscription reads the open tasks; while any listener is subscribed, an
   * index change re-reads them. While nothing is subscribed, the service does
   * not follow the index, and the next subscription reads the rows again.
   */
  subscribe: (listener: VoidFunction) => Unlisten
  /**
   * Re-read the open tasks, and the completed tasks while
   * {@link TaskService.includeCompleted} holds them, through the database. A
   * failed read is tried again until it lands; the rows stay as they are
   * meanwhile.
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
   * addresses the task as the index knew it. The rows of
   * {@link TaskService.get} are not touched.
   */
  writeTask(task: TaskRef, actions: readonly TaskAction[]): Promise<TaskWriteResult>
  /**
   * Continue entry from a grouped task: resolve the current draft and add a new
   * empty task at the end of the same parent item, or of the task's own list
   * under a heading, in one write. Changed content replaces the anchor's
   * Markdown; cleared content removes the anchor. The result addresses the
   * new task in the written note.
   */
  continueTaskInContext(task: TaskRef, content: string | null): Promise<InsertedTask>
  /**
   * Insert a new empty `+ [ ]` task into `notePath`'s `## Tasks` section
   * (Return-to-add), creating the section after the note's last content when
   * it has none, and return the new task's address. A missing note (today's
   * daily not yet created) starts empty.
   */
  insertTask(notePath: string): Promise<InsertedTask>
  /**
   * Check `tasks` one write at a time. The rows leave the open list, join the
   * completed list as checked, and stay in the recently-completed set before
   * the first write. A failure leaves the rows of the writes that landed,
   * puts the other rows back, drops `tasks` from the recently-completed set,
   * and rethrows.
   */
  completeTasks(tasks: readonly OpenTask[]): Promise<void>
  /**
   * Uncheck `tasks` one write at a time. The rows return to the open list and
   * leave the completed list and the recently-completed set before the first
   * write. A failure puts back the rows whose write did not land and rethrows.
   */
  reopenTasks(tasks: readonly OpenTask[]): Promise<void>
  /**
   * Remove `tasks` from their notes one write at a time. The rows leave both
   * lists and the recently-completed set before the first write. A failure
   * puts back the rows whose write did not land, keeps the checked ones
   * struck again, and rethrows.
   */
  deleteTasks(tasks: readonly OpenTask[]): Promise<void>
  /**
   * Replace one task's Markdown. The row shows the new text and its due date
   * before the write; a failure puts the row back and rethrows.
   */
  editTask(task: OpenTask, content: string): Promise<void>
  /**
   * Set each task's due date to `isoDate`, or clear it for `null`, one write
   * at a time. The rows show the new date before the first write; a failure
   * puts back the rows whose write did not land and rethrows.
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
   * write; a failure puts the row back, keeps a checked task struck again,
   * and rethrows.
   */
  editAndConvertTask(task: OpenTask, content: string): Promise<void>
  /**
   * Toggle one task's checkbox, first replacing its Markdown unless `content`
   * is `null`, in one write. The row moves between the lists and the
   * recently-completed set before the write; a failure puts the row and the
   * set back, and rethrows.
   */
  editAndToggleTask(task: OpenTask, content: string | null): Promise<void>
  /**
   * Add an empty task to `target`'s note ({@link TaskService.insertTask}) and
   * return its row, already in the open list.
   */
  addTask(target: InsertTaskTarget): Promise<OpenTask>
  /**
   * Resolve `task`'s draft and add an empty task after it
   * ({@link TaskService.continueTaskInContext}), and return the new row,
   * already in the open list. The anchor row shows its draft before the
   * write; a failure puts the anchor row back and rethrows.
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
  relocateRecentlyCompleted(root: string | null, notePath: string, edit: TaskMoves): void
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
   * The session's struck rows and the graph they belong to.
   */
  readonly recentlyCompleted: Store<RecentlyCompleted>
}

/**
 * The struck rows not superseded by a live open row — the pure core of the
 * reconciliation, shared by the store prune
 * ({@link TaskService.reconcileRecentlyCompleted}) and the render-time view.
 * A struck task that {@link isReopenedAfter} an open row of the same key was
 * reopened at the source note, so the struck copy is dropped and the live
 * open row shows instead of a stale `[x]` shadow (whose reopen write-back
 * would fail: the `[x]` line is no longer in the note). Returns the input
 * array itself when nothing is dropped, so callers can compare by reference.
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
    return live === undefined || !isReopenedAfter(task, live)
  })
  return next.length === struck.length ? struck : next
}

/**
 * Whether the open row `live` comes from a note state after the one `struck`
 * was completed in. A provisional test on `updatedAt`, the only field of a row
 * that changes with the note: a larger value means the note was rewritten and
 * reindexed since the completion, and an equal or smaller one is an index read
 * from before the completion landed.
 */
function isReopenedAfter(struck: OpenTask, live: OpenTask): boolean {
  return live.updatedAt > struck.updatedAt
}

/**
 * Only the locator goes to the core edit: the note path merely picks the owner.
 */
function toLocator(task: TaskRef): TaskLocator {
  return {
    revision: task.revision,
    astPath: task.astPath,
    markdown: task.markdown,
    checked: task.checked,
  }
}

function requireInserted(result: TaskEditResult): TaskSnapshot {
  const created = result.inserted[0]
  if (created === undefined) {
    throw new Error('The new task was not written.')
  }
  return created
}

/**
 * The tasks `result` left in `notePath`, for the store.
 */
function toCommit(notePath: string, result: TaskWriteResult): TaskCommit {
  return {
    notePath,
    revision: result.revision,
    tasks: result.tasks,
    baseRevision: result.baseRevision,
    moves: result.merged ? null : result.moved,
    inserted: result.inserted,
    indexSeq: result.indexSeq,
    updatedAt: result.updatedAt,
  }
}

function toOps(taskId: string, actions: readonly TaskAction[]): TaskItemOp[] {
  return actions.map((action) => ({ ...action, taskId }))
}

const EMPTY: readonly OpenTask[] = []

/**
 * Spacing between index-change re-reads while the index applies batch after batch.
 */
const REFRESH_THROTTLE_MS = 3_000

function sessionKey(session: GraphSession | null): string | null {
  return session === null ? null : `${session.generation}:${session.root}`
}

function keysOf(tasks: readonly OpenTask[]): string[] {
  return tasks.map(getTaskKey)
}

function toState(view: TaskStoreView): TaskListState {
  return { open: view.open, completed: view.completed }
}

/**
 * One write of a batch: the task, its actions, and the ops its row shows meanwhile.
 */
interface BatchWrite {
  readonly task: OpenTask
  readonly actions: readonly TaskAction[]
  readonly pending: PendingWrite
}

class TaskServiceImpl implements TaskService {
  readonly #deps: TaskServiceDeps
  readonly #reader: TaskReader
  readonly #recentlyCompleted = new WritableStore<RecentlyCompleted>(
    { root: null, tasks: EMPTY },
    isShallowEqual,
  )
  readonly recentlyCompleted: Store<RecentlyCompleted> = this.#recentlyCompleted
  #nextTaskId = 0
  #store = this.#createStore()
  readonly #state = new WritableStore<TaskListState>(toState(this.#store.view()), isShallowEqual)
  #sessionKey: string | null = null
  #indexGeneration: number | null = null
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
  #lastRefreshAt = -Infinity
  #trailingRefresh: TimerHandle | null = null

  constructor(deps: TaskServiceDeps) {
    this.#deps = deps
    this.#reader = createTaskReader(deps)
  }

  readonly get = this.#state.get

  readonly subscribe = (listener: VoidFunction): Unlisten => {
    const unlisten = this.#state.subscribe(listener)
    this.#sources ??= this.#startSources()
    this.#syncSession()
    if (this.#stale) {
      void this.refresh()
    }
    return () => {
      unlisten()
      if (!this.#state.subscribed()) {
        this.#sources?.()
        this.#sources = null
      }
    }
  }

  refresh(): Promise<void> {
    this.#syncSession()
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
    this.#syncSession()
    if (this.#store.view().completed === undefined) {
      void this.refresh()
    }
    let held = true
    return () => {
      if (held) {
        held = false
        this.#completedHolds -= 1
      }
    }
  }

  async writeTask(task: TaskRef, actions: readonly TaskAction[]): Promise<TaskWriteResult> {
    const { generation } = requireGraphSession(this.#deps.graphSession)
    const locator = toLocator(task)
    return await this.#writeEdits(
      generation,
      task.notePath,
      actions.map((action) => ({ ...action, task: locator })),
      false,
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
    const result = await this.#writeEdits(generation, task.notePath, edits, false)
    return { ...result, created: requireInserted(result) }
  }

  async insertTask(notePath: string): Promise<InsertedTask> {
    const { generation } = requireGraphSession(this.#deps.graphSession)
    const result = await this.#writeEdits(
      generation,
      notePath,
      [{ kind: 'insert', at: { kind: 'tasksSection' }, markdown: '' }],
      true,
    )
    return { ...result, created: requireInserted(result) }
  }

  async completeTasks(tasks: readonly OpenTask[]): Promise<void> {
    const session = this.#begin()
    const { root } = session
    this.markRecentlyCompleted(root, tasks)
    try {
      await this.#writeEach(session, tasks, () => [{ kind: 'toggle' }])
    } catch (cause) {
      this.forgetRecentlyCompleted(root, keysOf(tasks))
      throw cause
    }
  }

  async reopenTasks(tasks: readonly OpenTask[]): Promise<void> {
    const session = this.#begin()
    this.forgetRecentlyCompleted(session.root, keysOf(tasks))
    await this.#writeEach(session, tasks, () => [{ kind: 'toggle' }])
  }

  async deleteTasks(tasks: readonly OpenTask[]): Promise<void> {
    await this.#removeEach(tasks, 'remove')
  }

  async editTask(task: OpenTask, content: string): Promise<void> {
    await this.#writeEach(this.#begin(), [task], () => [{ kind: 'setMarkdown', markdown: content }])
  }

  async scheduleTasks(tasks: readonly OpenTask[], isoDate: string | null): Promise<void> {
    await this.#writeEach(this.#begin(), tasks, (task) => [
      { kind: 'setMarkdown', markdown: getScheduledMarkdown(task, isoDate) },
    ])
  }

  async convertTasks(tasks: readonly OpenTask[]): Promise<void> {
    await this.#removeEach(tasks, 'toBullet')
  }

  async editAndConvertTask(task: OpenTask, content: string): Promise<void> {
    const session = this.#begin()
    const { root } = session
    this.forgetRecentlyCompleted(root, [getTaskKey(task)])
    try {
      await this.#writeEach(session, [task], () => [
        { kind: 'setMarkdown', markdown: content },
        { kind: 'toBullet' },
      ])
    } catch (cause) {
      if (task.checked) {
        this.markRecentlyCompleted(root, [task])
      }
      throw cause
    }
  }

  async editAndToggleTask(task: OpenTask, content: string | null): Promise<void> {
    const session = this.#begin()
    const { root } = session
    const wasRecentlyCompleted = this.hasRecentlyCompleted(root, getTaskKey(task))
    const actions: TaskAction[] =
      content === null
        ? [{ kind: 'toggle' }]
        : [{ kind: 'setMarkdown', markdown: content }, { kind: 'toggle' }]
    if (task.checked) {
      this.forgetRecentlyCompleted(root, [getTaskKey(task)])
    } else {
      // The struck row shows the edited text.
      this.markRecentlyCompleted(root, toOps(task.taskId, actions).reduce(applyTaskOp, [task]))
    }
    try {
      await this.#writeEach(session, [task], () => actions)
    } catch (cause) {
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
    const store = this.#store
    const result = await this.insertTask(target.notePath)
    return this.#landInserted(session, store, target, null, [], result)
  }

  async addTaskAfter(task: OpenTask, content: string | null): Promise<OpenTask> {
    const session = this.#begin()
    const store = this.#store
    // The anchor resolves in the same write: a cleared row leaves, an edited one shows its text.
    const ops: TaskItemOp[] =
      content === ''
        ? [{ kind: 'remove', taskId: task.taskId }]
        : content === null
          ? []
          : [{ kind: 'setMarkdown', taskId: task.taskId, markdown: content }]
    const pending = store.push(task.notePath, ops)
    this.#publish()
    let result: InsertedTask
    try {
      result = await this.continueTaskInContext(this.#refOf(store, task), content)
    } catch (cause) {
      store.drop(pending)
      this.#publish()
      throw cause
    }
    store.drop(pending)
    return this.#landInserted(session, store, task, task.taskId, ops, result)
  }

  resolveSnippetTask(tasks: readonly SnippetTask[], click: SnippetTaskClick): SnippetTask | null {
    return resolveSnippetTask(this.#deps.progress, tasks, click)
  }

  async toggleSnippetTask(
    notePath: string,
    task: { locator: TaskLocator; checked: boolean },
  ): Promise<void> {
    await toggleSnippetTask(
      this.#deps.graphSession,
      this.#deps.progress,
      async (ref) => {
        const store = this.#store
        const result = await this.writeTask(ref, [{ kind: 'toggle' }])
        store.landCommit(toCommit(notePath, result), null)
        this.#publish()
      },
      notePath,
      task,
    )
  }

  markRecentlyCompleted(root: string | null, completed: readonly OpenTask[]): void {
    if (completed.length === 0) {
      return
    }
    // Another graph's set is discarded.
    const current = this.#recentlyCompleted.get()
    const struck = root === current.root ? current.tasks : EMPTY
    const byKey = new Map(struck.map((task) => [getTaskKey(task), task]))
    for (const task of completed) {
      byKey.set(getTaskKey(task), withChecked(task, true))
    }
    this.#recentlyCompleted.set({ root, tasks: [...byKey.values()] })
  }

  forgetRecentlyCompleted(root: string | null, keys: readonly string[]): void {
    const current = this.#recentlyCompleted.get()
    if (root !== current.root || keys.length === 0) {
      return
    }
    const drop = new Set(keys)
    const next = current.tasks.filter((task) => !drop.has(getTaskKey(task)))
    if (next.length !== current.tasks.length) {
      this.#recentlyCompleted.set({ root, tasks: next })
    }
  }

  hasRecentlyCompleted(root: string | null, key: string): boolean {
    const current = this.#recentlyCompleted.get()
    return root === current.root && current.tasks.some((task) => getTaskKey(task) === key)
  }

  relocateRecentlyCompleted(root: string | null, notePath: string, edit: TaskMoves): void {
    const current = this.#recentlyCompleted.get()
    if (root !== current.root || edit.moved.length === 0) {
      return
    }
    const next = withRelocatedTasks(current.tasks, notePath, edit) ?? []
    this.#recentlyCompleted.set({ root, tasks: next })
  }

  reconcileRecentlyCompleted(root: string | null, open: readonly OpenTask[]): void {
    const current = this.#recentlyCompleted.get()
    if (root !== current.root) {
      return
    }
    this.#recentlyCompleted.set({ root, tasks: withoutReopenedTasks(current.tasks, open) })
  }

  archiveRecentlyCompleted(root: string | null): void {
    const current = this.#recentlyCompleted.get()
    if (root !== current.root || current.tasks.length > 0) {
      // Also switches the active graph, discarding any other graph's set.
      this.#recentlyCompleted.set({ root, tasks: EMPTY })
    }
  }

  #createStore(): TaskStore {
    return new TaskStore(() => {
      this.#nextTaskId += 1
      return `task-${this.#nextTaskId}`
    })
  }

  /**
   * Listen for index changes and graph switches. The returned function stops
   * listening and marks the rows stale, since later changes go unseen.
   */
  #startSources(): Unlisten {
    const { graphSession, indexLifecycle, role, ipc, logger, clock } = this.#deps
    const unlisteners = [
      graphSession.subscribe(() => {
        if (this.#adoptSession()) {
          this.#publish()
          void this.refresh()
        }
      }),
      indexLifecycle.onApplied(() => this.#throttledInvalidate()),
      // A manual rebuild skips the watcher pipeline and its applied events.
      indexLifecycle.onReconciled((event) => {
        if (event.source !== 'sync') {
          this.#invalidate()
        }
      }),
    ]
    if (role !== 'main') {
      // A note window runs no indexer; the main window's committed writes reach it here.
      unlisteners.push(
        listenNow(
          () => ipc.listen(INDEX_COMMITTED_EVENT, () => this.#throttledInvalidate()),
          (cause) => {
            logger.error(`${INDEX_COMMITTED_EVENT} listener failed:`, cause)
          },
        ),
      )
    }
    return () => {
      for (const unlisten of unlisteners) {
        unlisten()
      }
      if (this.#trailingRefresh !== null) {
        clock.clearTimeout(this.#trailingRefresh)
        this.#trailingRefresh = null
      }
      this.#stale = true
    }
  }

  /**
   * Start an empty store for a graph that replaced the open one; `true` when
   * it did. An index that was opened again counts its seqs from zero.
   */
  #adoptSession(): boolean {
    const { session } = this.#deps.graphSession.get()
    const indexGeneration = session?.indexGeneration ?? null
    if (indexGeneration !== this.#indexGeneration) {
      this.#indexGeneration = indexGeneration
      this.#store.forgetSeqs()
    }
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
    return true
  }

  #syncSession(): void {
    if (this.#adoptSession()) {
      this.#publish()
    }
  }

  /**
   * Read the tasks of every note into the store, again while the index
   * changed during the read.
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
      store.landAll(read, completed)
      this.#publish()
    } while (this.#readAgain && !signal.aborted)
  }

  /**
   * Re-read the rows when a screen shows them, else mark them stale for the next one.
   */
  #invalidate(): void {
    if (this.#state.subscribed()) {
      void this.refresh()
    } else {
      this.#stale = true
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
    this.#state.set(toState(this.#store.view()))
  }

  /**
   * The open graph at the start of a write, with its store adopted.
   */
  #begin(): GraphSession {
    const session = requireGraphSession(this.#deps.graphSession)
    this.#syncSession()
    return session
  }

  /**
   * The address of `task` as `store` holds it, else as the row itself gives it.
   */
  #refOf(store: TaskStore, task: OpenTask): TaskRef {
    return store.find(task.notePath, task.taskId) ?? task
  }

  /**
   * Write `tasks` one at a time. Every row shows its actions before the
   * first write; a write that lands replaces the rows of its note. After a
   * failure the rows of that write and of the writes not yet made show their
   * tasks as the store holds them.
   */
  async #writeEach(
    session: GraphSession,
    tasks: readonly OpenTask[],
    actionsFor: (task: OpenTask) => readonly TaskAction[],
  ): Promise<void> {
    const store = this.#store
    const writes = tasks.map((task): BatchWrite => {
      const actions = actionsFor(task)
      return { task, actions, pending: store.push(task.notePath, toOps(task.taskId, actions)) }
    })
    this.#publish()
    for (const [i, { task, actions, pending }] of writes.entries()) {
      try {
        // After the batch's graph closes or switches, a write would land in the next graph.
        if (session.signal.aborted) {
          throw new AppError('noGraph', 'No graph is open.')
        }
        const result = await this.writeTask(this.#refOf(store, task), actions)
        store.landCommit(toCommit(task.notePath, result), pending)
        this.relocateRecentlyCompleted(session.root, task.notePath, result)
      } catch (cause) {
        for (const write of writes.slice(i)) {
          store.drop(write.pending)
        }
        this.#publish()
        throw cause
      }
      this.#publish()
    }
  }

  /**
   * Delete or convert `tasks`: the rows leave both lists outright.
   */
  async #removeEach(tasks: readonly OpenTask[], kind: 'remove' | 'toBullet'): Promise<void> {
    const session = this.#begin()
    const { root } = session
    this.forgetRecentlyCompleted(root, keysOf(tasks))
    try {
      await this.#writeEach(session, tasks, () => [{ kind }])
    } catch (cause) {
      // A checked task is still `[x]` on disk: keep it struck, or it would vanish from the list.
      this.markRecentlyCompleted(
        root,
        tasks.filter((task) => task.checked),
      )
      throw cause
    }
  }

  /**
   * Put the tasks an insert left into `store`, with a new id for the
   * inserted task, and return that task's row. `after` and `ops` are the
   * anchor of the insert and the changes the same write made to it.
   */
  #landInserted(
    session: GraphSession,
    store: TaskStore,
    target: InsertTaskTarget,
    after: string | null,
    ops: readonly TaskItemOp[],
    result: InsertedTask,
  ): OpenTask {
    const { notePath, noteTitle, dailyDate, isPinned, pinnedOrder } = target
    const taskId = store.createTaskId()
    const insert: TaskOp = {
      kind: 'insert',
      taskId,
      note: { notePath, noteTitle, dailyDate, isPinned, pinnedOrder },
      after,
      markdown: '',
      updatedAt: result.updatedAt,
    }
    store.landCommit(toCommit(notePath, result), store.push(notePath, [insert, ...ops]))
    this.relocateRecentlyCompleted(session.root, notePath, result)
    this.#publish()
    return (
      store.find(notePath, taskId) ??
      store.view().open?.find((row) => {
        return row.notePath === notePath && isSameTaskPath(row.astPath, result.created.astPath)
      }) ??
      createInsertedTaskRow(target, result.created, result.revision, result.updatedAt)
    )
  }

  async #writeEdits(
    generation: number,
    notePath: string,
    edits: readonly TaskEdit[],
    createIfMissing: boolean,
  ): Promise<TaskWriteResult> {
    const { noteDocuments, clock } = this.#deps
    let result: TaskEditResult | undefined
    const commit = await noteDocuments.commitSourceEdit(
      notePath,
      (source, revision) => {
        result = applyTaskEdits(source, revision, edits)
        return result.source
      },
      { generation, createIfMissing },
    )
    if (result === undefined || commit.revision === null) {
      throw new NoteEditError(
        'notWritable',
        'This note can’t be updated right now — try again in a moment.',
      )
    }
    return {
      ...result,
      revision: commit.revision,
      tasks: commit.merged ? projectTasks(splitFrontmatter(commit.content).body) : result.tasks,
      merged: commit.merged,
      indexSeq: commit.indexSeq,
      updatedAt: clock.now(),
    }
  }
}

export function createTaskService(deps: TaskServiceDeps): TaskService {
  return new TaskServiceImpl(deps)
}
