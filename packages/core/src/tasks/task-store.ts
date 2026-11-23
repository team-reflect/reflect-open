import type { NoteTasks, TaskRead } from '@reflect/types'
import {
  compareTaskPaths,
  encodeTaskPath,
  renderTaskSnapshot,
  type TaskEditResult,
  type TaskMove,
  type TaskSnapshot,
} from '../markdown/index.ts'
import type { Unlisten } from '../unlisten.ts'
import type { OpenTask } from './open-task.ts'
import { toInsertTarget, type InsertTaskTarget } from './task-insert-target.ts'
import { applyTaskOp, type TaskInsertOp, type TaskOp } from './task-ops.ts'
import { reconcileNoteTasks } from './task-reconcile.ts'

/**
 * The tasks of one note as the store last learned them.
 */
interface NoteEntry {
  /**
   * The hash of the note text the rows describe.
   */
  readonly revision: string
  /**
   * Whether the rows hold the checked tasks of the note too.
   */
  readonly complete: boolean
  /**
   * In document order.
   */
  readonly rows: readonly OpenTask[]
}

/**
 * A write in flight: the ops that the rows of its note show until it ends.
 */
export interface PendingWrite {
  readonly notePath: string
  readonly ops: readonly TaskOp[]
}

/**
 * The task a row shows, without its address.
 */
export type TaskIdentity = Pick<OpenTask, 'notePath' | 'taskId'>

/**
 * The text typed into the editor of a task since the editor opened.
 */
interface TaskDraft {
  readonly notePath: string
  /**
   * The Markdown of the task when the first text arrived.
   */
  readonly base: string
  readonly markdown: string
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
 * The rows the Tasks view shows.
 */
export interface TaskStoreView {
  /**
   * The unchecked tasks, by note path, then in document order; `undefined`
   * until a read of every note lands.
   */
  readonly open: readonly OpenTask[] | undefined
  /**
   * The checked tasks, most recently changed note first; `undefined` while
   * the store does not hold the checked tasks of every note.
   */
  readonly completed: readonly OpenTask[] | undefined
  /**
   * The checked tasks that stay in the active list: the struck tasks.
   */
  readonly struck: readonly OpenTask[]
}

type NoteContext = Pick<
  OpenTask,
  'notePath' | 'noteTitle' | 'dailyDate' | 'isPinned' | 'pinnedOrder' | 'updatedAt'
>

function toNoteContext(note: NoteTasks): NoteContext {
  return {
    notePath: note.path,
    noteTitle: note.title,
    dailyDate: note.dailyDate,
    isPinned: note.isPinned,
    pinnedOrder: note.pinnedOrder,
    updatedAt: note.updatedAt,
  }
}

function hasSameContext(row: OpenTask | undefined, context: NoteContext): boolean {
  return (
    row !== undefined &&
    row.noteTitle === context.noteTitle &&
    row.dailyDate === context.dailyDate &&
    row.isPinned === context.isPinned &&
    row.pinnedOrder === context.pinnedOrder &&
    row.updatedAt === context.updatedAt
  )
}

const NO_TASKS: readonly OpenTask[] = []

function compareByRecency(left: OpenTask, right: OpenTask): number {
  return right.updatedAt - left.updatedAt
}

/**
 * The task rows of the open graph. The base holds the tasks of each note as
 * the last read or write of that note left them, with the index seq it was
 * learned at. The view is the base with the ops of every write in flight
 * applied. A task keeps its id while reads and writes replace its note.
 * The struck set is view state: it names tasks by id and holds no row.
 * A new task is a row with no write in flight: it shows until it is taken.
 * A held text is the text of a write that failed: its row shows it until it
 * is taken. A draft is typed text that no row shows.
 */
export class TaskStore {
  /**
   * Makes an id that no task of this store holds.
   */
  readonly #createTaskId: () => string
  readonly #notes = new Map<string, NoteEntry>()
  /**
   * The index seq each path was last learned at, kept after the path has no task.
   */
  readonly #seqs = new Map<string, number>()
  #pending: PendingWrite[] = []
  /**
   * The new tasks and the held texts that no write holds, by task id.
   */
  readonly #unwritten = new Map<string, PendingWrite>()
  readonly #drafts = new Map<string, TaskDraft>()
  /**
   * The ids of the tasks that stay in the active list while they are checked.
   */
  #struck = new Set<string>()
  #loaded = false
  #completedLoaded = false
  #view: TaskStoreView | null = null
  readonly #listeners = new Set<VoidFunction>()
  /**
   * How many {@link TaskStore.batch} calls are running.
   */
  #batches = 0
  /**
   * The view changed during the batches that are running.
   */
  #changed = false

  constructor(createTaskId: () => string) {
    this.#createTaskId = createTaskId
  }

  /**
   * Take a read of every note: of the unchecked tasks, or with `completed` of
   * the checked tasks too. A note that the store learned at a later index seq
   * keeps its rows. So does a changed note with a struck task when the read
   * holds no checked task: the paths of these notes are returned, for a read
   * of every task of them.
   */
  landAll(read: TaskRead, completed: boolean): string[] {
    return this.batch(() => {
      const seen = new Set<string>()
      const unread: string[] = []
      for (const note of read.notes) {
        seen.add(note.path)
        if (!completed && this.#losesStruck(note)) {
          unread.push(note.path)
        } else if (this.#isCurrent(note.path, read.seq)) {
          this.#setNote(toNoteContext(note), note.hash, note.tasks, completed, null, [], [])
          this.#seqs.set(note.path, read.seq)
        }
      }
      for (const path of this.#notes.keys()) {
        if (!seen.has(path) && this.#isCurrent(path, read.seq)) {
          this.#clearNote(path, completed)
          this.#seqs.set(path, read.seq)
        }
      }
      if (!this.#loaded || this.#completedLoaded !== completed) {
        this.#loaded = true
        this.#completedLoaded = completed
        this.#invalidate()
      }
      return unread
    })
  }

  /**
   * Take a read of every task of the notes at `paths`. A path that is absent
   * from the read has no task.
   */
  landPaths(read: TaskRead, paths: readonly string[]): void {
    this.batch(() => {
      const seen = new Set<string>()
      for (const note of read.notes) {
        seen.add(note.path)
        if (this.#isCurrent(note.path, read.seq)) {
          this.#setNote(toNoteContext(note), note.hash, note.tasks, true, null, [], [])
          this.#seqs.set(note.path, read.seq)
        }
      }
      for (const path of paths) {
        if (!seen.has(path) && this.#isCurrent(path, read.seq)) {
          this.#clearNote(path, true)
          this.#seqs.set(path, read.seq)
        }
      }
    })
  }

  /**
   * Show `ops` on the rows of `notePath` until the returned write ends with
   * {@link TaskStore.landCommit} or {@link TaskStore.fail}.
   */
  begin(notePath: string, ops: readonly TaskOp[]): PendingWrite {
    const write = { notePath, ops }
    this.#pending.push(write)
    this.#invalidate()
    return write
  }

  /**
   * `write` as it runs: each op that names a new task no write holds is
   * folded into the insert of that task, which the returned write holds.
   */
  fold(write: PendingWrite): PendingWrite {
    return this.batch(() => {
      const { notePath, ops } = write
      const kept: TaskOp[] = []
      const inserts = new Map<string, TaskInsertOp>()
      for (const op of ops) {
        const insert =
          op.kind === 'insert'
            ? undefined
            : (inserts.get(op.taskId) ?? this.#takeNewTask(op.taskId))
        if (op.kind === 'insert' || insert === undefined) {
          kept.push(op)
          continue
        }
        switch (op.kind) {
          case 'setMarkdown': {
            inserts.set(op.taskId, { ...insert, markdown: op.markdown })
            break
          }
          case 'toggle': {
            inserts.set(op.taskId, { ...insert, checked: op.checked })
            break
          }
          case 'toBullet': {
            inserts.set(op.taskId, { ...insert, bullet: true })
            break
          }
          case 'remove': {
            inserts.delete(op.taskId)
            break
          }
        }
      }
      if (kept.length === ops.length) {
        return write
      }
      this.#drop(write)
      return this.begin(notePath, [...kept, ...inserts.values()])
    })
  }

  /**
   * End a write that left nothing in its note: its ops leave the rows. Text
   * that was not written stays in its row until {@link TaskStore.takeText}:
   * a new task of the write shows again, unchecked, and the text of a task
   * of the note shows as held text.
   */
  fail(write: PendingWrite): void {
    this.batch(() => {
      this.#drop(write)
      for (const op of write.ops) {
        if (op.kind === 'insert') {
          this.#showNewTask({ ...op, checked: false, bullet: false })
        } else if (
          op.kind === 'setMarkdown' &&
          this.find(write.notePath, op.taskId) !== undefined
        ) {
          this.#takeUnwritten(op.taskId)
          this.#unwritten.set(op.taskId, this.begin(write.notePath, [op]))
        }
      }
    })
  }

  /**
   * Show a new empty task in `note` that no write holds yet, and return its
   * row. It ends the list of the task `after`, or the Tasks section of the
   * note for `null`.
   */
  addNewTask(note: InsertTaskTarget, after: string | null, updatedAt: number): OpenTask {
    const taskId = this.#createTaskId()
    const { notePath } = note
    this.#showNewTask({
      kind: 'insert',
      taskId,
      note: toInsertTarget(note),
      after,
      markdown: '',
      updatedAt,
    })
    const row = this.rows(notePath).find((candidate) => candidate.taskId === taskId)
    if (row === undefined) {
      throw new Error('The new task has no row.')
    }
    return row
  }

  /**
   * Stop showing every new task that holds no text.
   */
  dropEmptyNewTasks(): void {
    this.batch(() => {
      for (const taskId of [...this.#unwritten.keys()]) {
        const text = this.#drafts.get(taskId)?.markdown ?? this.findNewTask(taskId)?.markdown
        if (text?.trim() === '' && this.#takeNewTask(taskId) !== undefined) {
          this.#drafts.delete(taskId)
        }
      }
    })
  }

  /**
   * The new task of `taskId` that no write holds yet.
   */
  findNewTask(taskId: string): TaskInsertOp | undefined {
    const op = this.#unwritten.get(taskId)?.ops[0]
    return op?.kind === 'insert' ? op : undefined
  }

  /**
   * Keep `markdown` as the text typed into the editor of `task`.
   */
  setDraft(task: Pick<OpenTask, 'notePath' | 'taskId' | 'markdown'>, markdown: string): void {
    const base = this.#drafts.get(task.taskId)?.base ?? task.markdown
    this.#drafts.set(task.taskId, { notePath: task.notePath, base, markdown })
  }

  /**
   * Take the text of `task` that no write holds, for a write to hold: its
   * draft, and its new task or held text, which stop showing. `markdown` is
   * the text to write and `base` the text it replaces. `insert` is the new
   * task, when `task` is one.
   */
  takeText(task: Pick<OpenTask, 'notePath' | 'taskId' | 'markdown'>): {
    base: string
    markdown: string
    insert?: TaskInsertOp | undefined
  } {
    const { taskId } = task
    const draft = this.#drafts.get(taskId)
    this.#drafts.delete(taskId)
    const insert = this.#takeNewTask(taskId)
    if (insert !== undefined) {
      return { base: '', markdown: draft?.markdown ?? insert.markdown, insert }
    }
    const op = this.#unwritten.get(taskId)?.ops[0]
    if (op?.kind !== 'setMarkdown') {
      const base = draft?.base ?? task.markdown
      return { base, markdown: draft?.markdown ?? base }
    }
    this.#takeUnwritten(taskId)
    const base = this.find(task.notePath, taskId)?.markdown ?? task.markdown
    return { base, markdown: draft?.markdown ?? op.markdown }
  }

  /**
   * The tasks that hold text no write has taken: every draft, held text, and
   * new task. A task whose text is blank is left out.
   */
  unsaved(): TaskIdentity[] {
    const tasks = new Map<string, TaskIdentity>()
    for (const [taskId, draft] of this.#drafts) {
      if (draft.markdown.trim() !== '') {
        tasks.set(taskId, { notePath: draft.notePath, taskId })
      }
    }
    for (const [taskId, write] of this.#unwritten) {
      const op = write.ops[0]
      const held = op?.kind === 'insert' || op?.kind === 'setMarkdown' ? op.markdown : ''
      if (!this.#drafts.has(taskId) && held.trim() !== '') {
        tasks.set(taskId, { notePath: write.notePath, taskId })
      }
    }
    return [...tasks.values()]
  }

  /**
   * End `write` with the tasks it left in `notePath`, or take the tasks of a
   * write that showed no ops. A task keeps its id through the moves of the
   * edit, and an inserted task takes the id of its insert op. A merged write
   * has no moves: an insert op then gives its id to the first task with its
   * content that is no task of the rows before. The tasks of a note the store
   * has no row context for are left to the next read. A note that the store
   * learned at a later index seq keeps its rows.
   */
  landCommit(notePath: string, result: TaskWriteResult, write: PendingWrite | null): void {
    this.batch(() => {
      const previous = this.#notes.get(notePath)
      const inserts =
        write?.ops.filter((op) => op.kind === 'insert').filter((op) => op.bullet !== true) ?? []
      const context = previous?.rows[0] ?? inserts[0]?.note
      const current = result.indexSeq === null || this.#isCurrent(notePath, result.indexSeq)
      if (context !== undefined && current) {
        const moves = result.merged ? null : result.moved
        const exact =
          moves !== null && (previous === undefined || previous.revision === result.baseRevision)
        this.#setNote(
          { ...toInsertTarget(context), notePath, updatedAt: result.updatedAt },
          result.revision,
          result.tasks,
          true,
          exact ? moves : null,
          moves === null
            ? []
            : result.inserted.flatMap((task, i) => {
                const insert = inserts[i]
                return insert === undefined ? [] : [[encodeTaskPath(task.astPath), insert.taskId]]
              }),
          moves === null ? inserts : [],
        )
        if (result.indexSeq !== null) {
          this.#seqs.set(notePath, result.indexSeq)
        }
      }
      if (write !== null) {
        this.#drop(write)
      }
    })
  }

  /**
   * Keep the tasks of `taskIds` in the active list while they are checked.
   */
  strike(taskIds: readonly string[]): void {
    for (const taskId of taskIds) {
      this.#struck.add(taskId)
    }
    this.#invalidate()
  }

  /**
   * Archive: no checked task stays in the active list.
   */
  archive(): void {
    this.#struck = new Set()
    this.#invalidate()
  }

  /**
   * The row of `taskId` in `notePath` as the base holds it, with the address
   * of the task in the note text at the row's revision.
   */
  find(notePath: string, taskId: string): OpenTask | undefined {
    return this.#notes.get(notePath)?.rows.find((row) => row.taskId === taskId)
  }

  /**
   * The rows of `notePath` as the view shows them, in document order.
   */
  rows(notePath: string): readonly OpenTask[] {
    let rows = this.#notes.get(notePath)?.rows ?? NO_TASKS
    for (const write of this.#pending) {
      if (write.notePath === notePath) {
        rows = write.ops.reduce(applyTaskOp, rows)
      }
    }
    return rows
  }

  /**
   * The same object until the rows change.
   */
  view(): TaskStoreView {
    this.#view ??= this.#computeView()
    return this.#view
  }

  /**
   * Call `listener` after each change of {@link TaskStore.view}.
   */
  subscribe(listener: VoidFunction): Unlisten {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Run `change` and call the listeners once after it, when the view changed.
   */
  batch<Result>(change: () => Result): Result {
    this.#batches += 1
    try {
      return change()
    } finally {
      this.#batches -= 1
      if (this.#batches === 0 && this.#changed) {
        this.#changed = false
        this.#notify()
      }
    }
  }

  #invalidate(): void {
    this.#view = null
    if (this.#batches > 0) {
      this.#changed = true
    } else {
      this.#notify()
    }
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }

  #drop(write: PendingWrite): void {
    this.#pending = this.#pending.filter((pending) => pending !== write)
    this.#invalidate()
  }

  #showNewTask(op: TaskInsertOp): void {
    this.#unwritten.set(op.taskId, this.begin(op.note.notePath, [op]))
  }

  /**
   * Stop showing the new task of `taskId` and return it.
   */
  #takeNewTask(taskId: string): TaskInsertOp | undefined {
    const op = this.findNewTask(taskId)
    if (op !== undefined) {
      this.#takeUnwritten(taskId)
    }
    return op
  }

  #takeUnwritten(taskId: string): void {
    const write = this.#unwritten.get(taskId)
    if (write !== undefined) {
      this.#unwritten.delete(taskId)
      this.#drop(write)
    }
  }

  /**
   * Whether the rows of the note hold a struck task that the tasks of
   * `note`, read from another text without its checked tasks, would drop.
   */
  #losesStruck(note: NoteTasks): boolean {
    const previous = this.#notes.get(note.path)
    return (
      previous !== undefined &&
      previous.revision !== note.hash &&
      previous.rows.some((row) => row.checked && this.#struck.has(row.taskId))
    )
  }

  #isCurrent(path: string, seq: number): boolean {
    return seq >= (this.#seqs.get(path) ?? 0)
  }

  #setNote(
    context: NoteContext,
    revision: string,
    tasks: readonly TaskSnapshot[],
    complete: boolean,
    moves: readonly TaskMove[] | null,
    insertedIds: ReadonlyArray<readonly [path: string, taskId: string]>,
    unplaced: readonly TaskInsertOp[],
  ): void {
    const { notePath } = context
    const previous = this.#notes.get(notePath)
    if (
      previous !== undefined &&
      previous.revision === revision &&
      (previous.complete || !complete) &&
      hasSameContext(previous.rows[0], context)
    ) {
      return
    }
    this.#invalidate()
    if (tasks.length === 0) {
      this.#notes.delete(notePath)
      return
    }
    const ordered = tasks.toSorted((left, right) => compareTaskPaths(left.astPath, right.astPath))
    const ids = reconcileNoteTasks(previous?.rows ?? [], ordered, moves, this.#createTaskId)
    const known = new Set(previous?.rows.map((row) => row.taskId))
    for (const op of unplaced) {
      const index = ordered.findIndex((task, i) => {
        return (
          !known.has(ids[i]!) &&
          task.markdown === op.markdown.trim() &&
          task.checked === (op.checked === true)
        )
      })
      if (index !== -1) {
        ids[index] = op.taskId
        known.add(op.taskId)
      }
    }
    const inserted = new Map(insertedIds)
    const rows = ordered.map((task, i): OpenTask => ({
      ...context,
      ...renderTaskSnapshot(task),
      taskId: inserted.get(encodeTaskPath(task.astPath)) ?? ids[i]!,
      revision,
    }))
    this.#notes.set(notePath, { revision, complete, rows })
  }

  /**
   * Drop the tasks of a note that a read did not return: every task, or for
   * a read of the unchecked tasks only those.
   */
  #clearNote(path: string, completed: boolean): void {
    const previous = this.#notes.get(path)
    if (previous === undefined) {
      return
    }
    const rows = completed || !previous.complete ? [] : previous.rows.filter((row) => row.checked)
    if (rows.length === previous.rows.length) {
      return
    }
    this.#invalidate()
    if (rows.length === 0) {
      this.#notes.delete(path)
    } else {
      this.#notes.set(path, { ...previous, rows })
    }
  }

  #computeView(): TaskStoreView {
    const paths = new Set([...this.#notes.keys(), ...this.#pending.map((write) => write.notePath)])
    const rows = [...paths].toSorted().flatMap((path) => this.rows(path))
    const struck = rows.filter((row) => row.checked && this.#struck.has(row.taskId))
    return {
      open: this.#loaded ? rows.filter((row) => !row.checked) : undefined,
      completed: this.#completedLoaded
        ? rows.filter((row) => row.checked).toSorted(compareByRecency)
        : undefined,
      struck: struck.length === 0 ? NO_TASKS : struck,
    }
  }
}
