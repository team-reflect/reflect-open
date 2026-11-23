import { noop } from '@ocavue/utils'
import type { ClockService } from '../ports/clock-service.ts'
import type { GraphSession } from '../graph/graph-session.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import type { NoteDocumentService } from '../documents/note-document-service.ts'
import type { Store } from '../store.ts'
import { splitFrontmatter } from '../markdown/frontmatter.ts'
import {
  applyTaskEdits,
  projectTasks,
  type TaskEdit,
  type TaskEditResult,
  type TaskLocator,
  type TaskSnapshot,
} from '../markdown/index.ts'
import type { OpenTask } from './open-task.ts'
import { resolveTaskEdit } from './task-content.ts'
import { NoteEditError } from './task-errors.ts'
import type { InsertTaskTarget } from './task-insert-target.ts'
import type { TaskOp } from './task-ops.ts'
import { withDraftDueDate } from './task-schedule-content.ts'
import type { TaskCommit, TaskStore } from './task-store.ts'

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
 * One change to a task.
 */
export type TaskAction =
  | { kind: 'toggle' }
  | { kind: 'setMarkdown'; markdown: string }
  | { kind: 'remove' }
  | { kind: 'toBullet' }

export interface TaskCommandsDeps {
  readonly noteDocuments: NoteDocumentService
  readonly progress: ProgressPort
  readonly clock: ClockService
  readonly logger: LoggerService
  readonly graphSession: Store<{ readonly session: GraphSession | null }>
  /**
   * The store of the open graph.
   */
  readonly store: () => TaskStore
  /**
   * Show the rows of the store.
   */
  readonly publish: () => void
  /**
   * Read the tasks of the note at `notePath` from the index into `store`, in
   * one try. A failed read rejects.
   */
  readonly reread: (store: TaskStore, notePath: string) => Promise<void>
}

function toLocator(task: TaskLocator): TaskLocator {
  return {
    revision: task.revision,
    astPath: task.astPath,
    markdown: task.markdown,
    checked: task.checked,
  }
}

/**
 * The tasks `result` left in `notePath`, for the store.
 */
export function toTaskCommit(notePath: string, result: TaskWriteResult): TaskCommit {
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

function toInsertTarget(task: InsertTaskTarget): InsertTaskTarget {
  const { notePath, noteTitle, dailyDate, isPinned, pinnedOrder } = task
  return { notePath, noteTitle, dailyDate, isPinned, pinnedOrder }
}

/**
 * The line a failed write shows, or `null` for a failure the user cannot act on.
 */
function describeFailure(cause: unknown): string | null {
  if (!(cause instanceof NoteEditError)) {
    return 'The task could not be saved.'
  }
  switch (cause.kind) {
    case 'invalidContent': {
      return 'This text cannot be saved as one task. Remove the line that starts a new block.'
    }
    case 'notWritable': {
      return cause.message
    }
    case 'stale':
    case 'conflict': {
      return null
    }
  }
}

/**
 * The changes the user makes to tasks. A command names its tasks by id. The
 * rows show the change at once. The writes of one note run one after the
 * other, and each takes the address of its tasks from the store when it
 * starts, so no command waits for another or is dropped. The changes one
 * command makes to several tasks of a note are one write. Different notes are
 * written at the same time.
 *
 * A write that finds its task gone reads the note from the index again and
 * runs once more. A write that still fails keeps the text of its tasks in
 * their rows for the next command that names them, drops its other changes,
 * and shows a line only when the user can act on it. A command settles
 * when its writes ended, and never rejects.
 */
export class TaskCommands {
  readonly #deps: TaskCommandsDeps
  /**
   * The last write queued for each note.
   */
  readonly #queues = new Map<string, Promise<void>>()

  constructor(deps: TaskCommandsDeps) {
    this.#deps = deps
  }

  /**
   * Keep `markdown` as the text of the editor of `task`. No row changes and
   * nothing is written until a command names the task.
   */
  setDraft(task: OpenTask, markdown: string): void {
    this.#deps.store().setDraft(task, markdown)
  }

  /**
   * Save the text typed into `task`. Text equal to the task's writes nothing.
   */
  commit(task: OpenTask): Promise<void> {
    return this.#apply([task], () => [])
  }

  /**
   * Save every typed text, for an app that is about to stop.
   */
  commitDrafts(): Promise<void> {
    const store = this.#deps.store()
    const tasks = store.unsaved().flatMap((task) => {
      const row = store.rows(task.notePath).find((candidate) => candidate.taskId === task.taskId)
      return row === undefined ? [] : [row]
    })
    return this.#apply(tasks, () => [])
  }

  /**
   * Check the open tasks of `tasks`. A task that becomes checked stays in
   * the active list, struck.
   */
  complete(tasks: readonly OpenTask[]): Promise<void> {
    const open = tasks.filter((task) => !task.checked)
    this.#deps.store().strike(open.map((task) => task.taskId))
    return this.#apply(open, () => [{ kind: 'toggle' }])
  }

  /**
   * Check the open tasks of `tasks`, or uncheck `tasks` when every one is
   * checked. A task that has the wanted state when its write starts is left
   * as it is.
   */
  toggle(tasks: readonly OpenTask[]): Promise<void> {
    return tasks.some((task) => !task.checked)
      ? this.complete(tasks)
      : this.#apply(tasks, () => [{ kind: 'toggle' }])
  }

  /**
   * Remove `tasks` from their notes. Nested items move up.
   */
  remove(tasks: readonly OpenTask[]): Promise<void> {
    return this.#apply(tasks, () => [{ kind: 'remove' }])
  }

  /**
   * Turn `tasks` into plain bullets: they stay in their notes and leave the rows.
   */
  convert(tasks: readonly OpenTask[]): Promise<void> {
    return this.#apply(tasks, () => [{ kind: 'toBullet' }])
  }

  /**
   * Set the due date of `tasks` to `isoDate`, or clear it for `null`.
   */
  schedule(tasks: readonly OpenTask[], isoDate: string | null): Promise<void> {
    return this.#apply(tasks, (markdown) => [
      { kind: 'setMarkdown', markdown: withDraftDueDate(markdown, isoDate) },
    ])
  }

  /**
   * Archive: no checked task stays in the active list. The tasks stay checked in their notes.
   */
  archive(): void {
    this.#deps.store().archive()
    this.#deps.publish()
  }

  /**
   * Show a new empty task in the Tasks section of `target` and return its
   * row. Nothing is written, and a missing note is not created, until a
   * command names the row while it holds text.
   */
  add(target: InsertTaskTarget): OpenTask {
    return this.#addNewTask(target, null)
  }

  /**
   * Save the text typed into `task`, then show a new empty task at the end
   * of its list and return the row. A new task with no text is replaced by
   * the new row.
   */
  continueAfter(task: OpenTask): OpenTask {
    const store = this.#deps.store()
    const replaced = store.findNewTask(task.taskId)
    void this.commit(task)
    const kept = store.rows(task.notePath).some((row) => row.taskId === task.taskId)
    return this.#addNewTask(task, kept ? task.taskId : (replaced?.after ?? null))
  }

  /**
   * Apply `edits` to the note at `notePath` in one write.
   */
  async write(
    generation: number,
    notePath: string,
    edits: readonly TaskEdit[],
  ): Promise<TaskWriteResult> {
    const { noteDocuments, clock } = this.#deps
    let result: TaskEditResult | undefined
    const commit = await noteDocuments.commitSourceEdit(
      notePath,
      (source, revision) => {
        result = applyTaskEdits(source, revision, edits)
        return result.source
      },
      {
        generation,
        createIfMissing: edits.some((edit) => {
          return edit.kind === 'insert' && edit.at.kind === 'tasksSection'
        }),
      },
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

  #addNewTask(target: InsertTaskTarget, after: string | null): OpenTask {
    const { clock, publish } = this.#deps
    const store = this.#deps.store()
    const row = store.addNewTask({
      kind: 'insert',
      taskId: store.createTaskId(),
      note: toInsertTarget(target),
      after,
      markdown: '',
      updatedAt: clock.now(),
    })
    publish()
    return row
  }

  /**
   * Save the text typed into each of `tasks`, then apply the actions that
   * `actionsFor` gives for the task's Markdown, in one write per note.
   */
  #apply(
    tasks: readonly OpenTask[],
    actionsFor: (markdown: string) => readonly TaskAction[],
  ): Promise<void> {
    const { session } = this.#deps.graphSession.get()
    if (session === null) {
      return Promise.resolve()
    }
    const store = this.#deps.store()
    const byNote = new Map<string, TaskOp[]>()
    for (const task of tasks) {
      const ops = this.#takeOps(store, task, actionsFor)
      if (ops.length > 0) {
        byNote.set(task.notePath, [...(byNote.get(task.notePath) ?? []), ...ops])
      }
    }
    this.#deps.publish()
    const writes = [...byNote].map(([notePath, ops]) => this.#queue(session, store, notePath, ops))
    return Promise.all(writes).then(noop)
  }

  /**
   * The ops of one command for one task, with the text typed into it.
   */
  #takeOps(
    store: TaskStore,
    task: OpenTask,
    actionsFor: (markdown: string) => readonly TaskAction[],
  ): TaskOp[] {
    const { taskId } = task
    const draft = store.takeDraft(taskId)
    const newTask = store.takeNewTask(taskId)
    if (newTask !== undefined) {
      const markdown = (draft?.markdown ?? newTask.markdown).trim()
      const actions = markdown === '' ? [] : actionsFor(markdown)
      // A new task with no text, or one that is removed, is dropped: nothing is written.
      if (markdown === '' || actions.some((action) => action.kind === 'remove')) {
        return []
      }
      const rewrite = actions.findLast((action) => action.kind === 'setMarkdown')
      return [
        {
          ...newTask,
          markdown: rewrite?.markdown ?? markdown,
          checked: actions.some((action) => action.kind === 'toggle'),
          bullet: actions.some((action) => action.kind === 'toBullet'),
        },
      ]
    }
    const held = store.takeHeldText(taskId)
    const base =
      held === undefined
        ? (draft?.base ?? task.markdown)
        : (store.find(task.notePath, taskId)?.markdown ?? task.markdown)
    const edit = resolveTaskEdit(base, draft?.markdown ?? held ?? base)
    // A task whose text was cleared is removed, whatever the command.
    if (edit.type === 'delete') {
      return [{ kind: 'remove', taskId }]
    }
    const saved: TaskOp[] =
      edit.type === 'commit' ? [{ kind: 'setMarkdown', taskId, markdown: edit.content }] : []
    const markdown = edit.type === 'commit' ? edit.content : base
    const ops = actionsFor(markdown).map((action): TaskOp => {
      return action.kind === 'toggle'
        ? { kind: 'toggle', taskId, checked: !task.checked }
        : { ...action, taskId }
    })
    return [...saved, ...ops]
  }

  /**
   * Show `ops` on the rows of `notePath` and write them after the writes
   * already queued for that note.
   */
  #queue(
    session: GraphSession,
    store: TaskStore,
    notePath: string,
    ops: readonly TaskOp[],
  ): Promise<void> {
    const { publish } = this.#deps
    const pending = store.push(notePath, ops)
    publish()
    const run = async (): Promise<void> => {
      try {
        const result = session.signal.aborted
          ? null
          : await this.#writeOps(session, store, notePath, ops)
        if (result === null) {
          store.drop(pending)
        } else {
          store.landCommit(toTaskCommit(notePath, result), pending)
        }
      } catch (cause) {
        store.drop(pending)
        if (session.signal.aborted) {
          return
        }
        // Text that was not written stays in its row until a later write takes it.
        for (const op of ops) {
          if (op.kind === 'insert') {
            store.addNewTask({ ...op, checked: false, bullet: false })
          } else if (op.kind === 'setMarkdown' && store.find(notePath, op.taskId) !== undefined) {
            store.holdText(notePath, op.taskId, op.markdown)
          }
        }
        this.#report(cause)
      }
      publish()
    }
    const queued = (this.#queues.get(notePath) ?? Promise.resolve()).then(run)
    this.#queues.set(notePath, queued)
    void queued.then(() => {
      if (this.#queues.get(notePath) === queued) {
        this.#queues.delete(notePath)
      }
    })
    return queued
  }

  /**
   * Write `ops`; `null` when no op names a task of the note. A write that
   * finds a task gone runs once more on the tasks the index holds, and ends
   * as it is when the index cannot be read.
   */
  async #writeOps(
    session: GraphSession,
    store: TaskStore,
    notePath: string,
    ops: readonly TaskOp[],
  ): Promise<TaskWriteResult | null> {
    let stale: unknown
    try {
      return await this.#writeOnce(session, store, notePath, ops)
    } catch (cause) {
      if (!(cause instanceof NoteEditError && cause.kind === 'stale')) {
        throw cause
      }
      stale = cause
    }
    try {
      await this.#deps.reread(store, notePath)
    } catch (cause) {
      this.#deps.logger.error('tasks: read failed:', cause)
      throw stale
    }
    return await this.#writeOnce(session, store, notePath, ops)
  }

  async #writeOnce(
    session: GraphSession,
    store: TaskStore,
    notePath: string,
    ops: readonly TaskOp[],
  ): Promise<TaskWriteResult | null> {
    const edits = ops.flatMap((op): TaskEdit[] => {
      if (op.kind === 'insert') {
        // An anchor that left the note sends the new task to the Tasks section.
        const anchor = op.after === null ? undefined : store.find(notePath, op.after)
        return [
          {
            kind: 'insert',
            at:
              anchor === undefined
                ? { kind: 'tasksSection' }
                : { kind: 'contextEnd', task: toLocator(anchor) },
            markdown: op.markdown,
            checked: op.checked,
            bullet: op.bullet,
          },
        ]
      }
      const { taskId, ...action } = op
      const row = store.find(notePath, taskId)
      if (row === undefined) {
        return []
      }
      const task = toLocator(row)
      if (action.kind !== 'toggle') {
        return [{ ...action, task }]
      }
      // A task that already has the state is left as it is.
      return row.checked === action.checked ? [] : [{ kind: 'toggle', task }]
    })
    return edits.length === 0 ? null : await this.write(session.generation, notePath, edits)
  }

  #report(cause: unknown): void {
    const { logger, progress } = this.#deps
    logger.error('tasks: write failed:', cause)
    const message = describeFailure(cause)
    if (message !== null) {
      progress.fail('Saving task', message)
    }
  }
}
