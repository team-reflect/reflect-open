import type { NoteTasks, TaskRead } from '@reflect/types'
import {
  compareTaskPaths,
  encodeTaskPath,
  renderTaskSnapshot,
  type TaskMove,
  type TaskSnapshot,
} from '../markdown/index.ts'
import type { OpenTask } from './open-task.ts'
import type { InsertTaskTarget } from './task-insert-target.ts'
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
 * The tasks a note write left in its note.
 */
export interface TaskCommit {
  readonly notePath: string
  /**
   * The hash of the note text the write left.
   */
  readonly revision: string
  /**
   * Every round task of that text.
   */
  readonly tasks: readonly TaskSnapshot[]
  /**
   * The hash of the text the edit was applied to, when the writer knew it.
   */
  readonly baseRevision: string | null
  /**
   * Where the edit left each task of the text at `baseRevision`; `null` when
   * the note holds another text than the output of the edit.
   */
  readonly moves: readonly TaskMove[] | null
  /**
   * The tasks the edit inserted, in the order of the insert ops of the write.
   */
  readonly inserted: readonly TaskSnapshot[]
  /**
   * The seq of an index commit that holds the text, when one is known.
   */
  readonly indexSeq: number | null
  /**
   * Epoch milliseconds when the write landed.
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

function toContext(source: OpenTask | InsertTaskTarget): Omit<NoteContext, 'updatedAt'> {
  const { notePath, noteTitle, dailyDate, isPinned, pinnedOrder } = source
  return { notePath, noteTitle, dailyDate, isPinned, pinnedOrder }
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
   * Make an id that no task of this store holds.
   */
  readonly createTaskId: () => string
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

  constructor(createTaskId: () => string) {
    this.createTaskId = createTaskId
  }

  /**
   * Take a read of every note: of the unchecked tasks, or with `completed` of
   * the checked tasks too. A note that the store learned at a later index seq
   * keeps its rows.
   */
  landAll(read: TaskRead, completed: boolean): void {
    const seen = new Set<string>()
    for (const note of read.notes) {
      seen.add(note.path)
      if (this.#isCurrent(note.path, read.seq)) {
        this.#setNote(toNoteContext(note), note.hash, note.tasks, completed, null, [])
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
      this.#view = null
    }
  }

  /**
   * Take a read of every task of the notes at `paths`. A path that is absent
   * from the read has no task.
   */
  landPaths(read: TaskRead, paths: readonly string[]): void {
    const seen = new Set<string>()
    for (const note of read.notes) {
      seen.add(note.path)
      if (this.#isCurrent(note.path, read.seq)) {
        this.#setNote(toNoteContext(note), note.hash, note.tasks, true, null, [])
        this.#seqs.set(note.path, read.seq)
      }
    }
    for (const path of paths) {
      if (!seen.has(path) && this.#isCurrent(path, read.seq)) {
        this.#clearNote(path, true)
        this.#seqs.set(path, read.seq)
      }
    }
  }

  /**
   * Show `ops` on the rows of `notePath` until the returned write ends with
   * {@link TaskStore.landCommit} or {@link TaskStore.drop}.
   */
  push(notePath: string, ops: readonly TaskOp[]): PendingWrite {
    const write = { notePath, ops }
    this.#pending.push(write)
    this.#view = null
    return write
  }

  /**
   * End a write that failed: its ops leave the rows.
   */
  drop(write: PendingWrite): void {
    this.#pending = this.#pending.filter((pending) => pending !== write)
    this.#view = null
  }

  /**
   * Show a new task that no write holds yet, and return its row.
   */
  addNewTask(op: TaskInsertOp): OpenTask {
    const { notePath } = op.note
    this.#unwritten.set(op.taskId, this.push(notePath, [op]))
    const row = this.rows(notePath).find((candidate) => candidate.taskId === op.taskId)
    if (row === undefined) {
      throw new Error('The new task has no row.')
    }
    return row
  }

  /**
   * The new task of `taskId` that no write holds yet.
   */
  findNewTask(taskId: string): TaskInsertOp | undefined {
    const op = this.#unwritten.get(taskId)?.ops[0]
    return op?.kind === 'insert' ? op : undefined
  }

  /**
   * Stop showing the new task of `taskId` and return it, for a write to hold.
   */
  takeNewTask(taskId: string): TaskInsertOp | undefined {
    const op = this.findNewTask(taskId)
    if (op !== undefined) {
      this.#takeUnwritten(taskId)
    }
    return op
  }

  /**
   * Show `markdown` as the text of the task of `taskId` in `notePath` until a
   * write takes it.
   */
  holdText(notePath: string, taskId: string, markdown: string): void {
    this.#takeUnwritten(taskId)
    this.#unwritten.set(taskId, this.push(notePath, [{ kind: 'setMarkdown', taskId, markdown }]))
  }

  /**
   * Stop showing the held text of `taskId` and return it, for a write to hold.
   */
  takeHeldText(taskId: string): string | undefined {
    const op = this.#unwritten.get(taskId)?.ops[0]
    if (op?.kind !== 'setMarkdown') {
      return undefined
    }
    this.#takeUnwritten(taskId)
    return op.markdown
  }

  /**
   * Keep `markdown` as the text typed into the editor of `task`.
   */
  setDraft(task: Pick<OpenTask, 'notePath' | 'taskId' | 'markdown'>, markdown: string): void {
    const base = this.#drafts.get(task.taskId)?.base ?? task.markdown
    this.#drafts.set(task.taskId, { notePath: task.notePath, base, markdown })
  }

  /**
   * Forget the draft of `taskId` and return it.
   */
  takeDraft(taskId: string): TaskDraft | undefined {
    const draft = this.#drafts.get(taskId)
    this.#drafts.delete(taskId)
    return draft
  }

  /**
   * The tasks that hold text no write has taken: every draft, held text, and
   * new task. A new task with no text is left out.
   */
  unsaved(): TaskIdentity[] {
    const tasks = new Map<string, TaskIdentity>()
    for (const [taskId, draft] of this.#drafts) {
      tasks.set(taskId, { notePath: draft.notePath, taskId })
    }
    for (const [taskId, write] of this.#unwritten) {
      const op = this.findNewTask(taskId)
      const markdown = this.#drafts.get(taskId)?.markdown ?? op?.markdown ?? ''
      if (op !== undefined && markdown.trim() === '') {
        tasks.delete(taskId)
      } else {
        tasks.set(taskId, { notePath: write.notePath, taskId })
      }
    }
    return [...tasks.values()]
  }

  /**
   * End `write` with the tasks it left in its note, or take the tasks of a
   * write that showed no ops. A task keeps its id through the moves of the
   * edit, and an inserted task takes the id of its insert op. The tasks of a
   * note the store has no row context for are left to the next read. A note
   * that the store learned at a later index seq keeps its rows.
   */
  landCommit(commit: TaskCommit, write: PendingWrite | null): void {
    const { notePath } = commit
    const previous = this.#notes.get(notePath)
    const inserts =
      write?.ops.filter((op) => op.kind === 'insert').filter((op) => op.bullet !== true) ?? []
    const context = previous?.rows[0] ?? inserts[0]?.note
    const current = commit.indexSeq === null || this.#isCurrent(notePath, commit.indexSeq)
    if (context !== undefined && current) {
      const exact =
        commit.moves !== null &&
        (previous === undefined || previous.revision === commit.baseRevision)
      this.#setNote(
        { ...toContext(context), notePath, updatedAt: commit.updatedAt },
        commit.revision,
        commit.tasks,
        true,
        exact ? commit.moves : null,
        commit.moves === null
          ? []
          : commit.inserted.flatMap((task, i) => {
              const insert = inserts[i]
              return insert === undefined ? [] : [[encodeTaskPath(task.astPath), insert.taskId]]
            }),
      )
      if (commit.indexSeq !== null) {
        this.#seqs.set(notePath, commit.indexSeq)
      }
    }
    if (write !== null) {
      this.drop(write)
    }
  }

  /**
   * Keep the tasks of `taskIds` in the active list while they are checked.
   */
  strike(taskIds: readonly string[]): void {
    for (const taskId of taskIds) {
      this.#struck.add(taskId)
    }
    this.#view = null
  }

  /**
   * Archive: no checked task stays in the active list.
   */
  archive(): void {
    this.#struck = new Set()
    this.#view = null
  }

  /**
   * Forget the index seqs, for an index that counts from zero again.
   */
  forgetSeqs(): void {
    this.#seqs.clear()
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

  #takeUnwritten(taskId: string): void {
    const write = this.#unwritten.get(taskId)
    if (write !== undefined) {
      this.#unwritten.delete(taskId)
      this.drop(write)
    }
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
    this.#view = null
    if (tasks.length === 0) {
      this.#notes.delete(notePath)
      return
    }
    const ordered = tasks.toSorted((left, right) => compareTaskPaths(left.astPath, right.astPath))
    const ids = reconcileNoteTasks(previous?.rows ?? [], ordered, moves, this.createTaskId)
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
    this.#view = null
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
