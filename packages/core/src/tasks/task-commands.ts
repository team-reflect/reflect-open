import { noop } from '@ocavue/utils'
import type { ClockService } from '../ports/clock-service.ts'
import { requireGraphSession, type GraphSession } from '../graph/graph-session.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import type { NoteDocumentService } from '../documents/note-document-service.ts'
import type { Store } from '../store.ts'
import { splitFrontmatter } from '../markdown/frontmatter.ts'
import {
  applyTaskEdits,
  projectTasks,
  toTaskLocator,
  type TaskEdit,
  type TaskEditResult,
  type TaskLocator,
} from '../markdown/index.ts'
import type { OpenTask } from './open-task.ts'
import { resolveTaskEdit } from './task-content.ts'
import { NoteEditError } from '../documents/note-edit-error.ts'
import type { InsertTaskTarget } from './task-insert-target.ts'
import type { TaskItemOp, TaskOp } from './task-ops.ts'
import { withDraftDueDate } from './task-schedule-content.ts'
import type { TaskReader } from './task-reader.ts'
import type { TaskStore, TaskWriteResult } from './task-store.ts'

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
  readonly reader: TaskReader
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
 * runs once more. A change to a new task whose write failed is written with
 * the new task. A write that still fails keeps the text of its tasks in
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
   * Save every typed text, for an app that is about to stop. A task whose
   * typed text is blank keeps that text for the command that names it.
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
    const store = this.#deps.store()
    return store.batch(() => {
      store.strike(open.map((task) => task.taskId))
      return this.#apply(open, ({ taskId }) => [{ kind: 'toggle', taskId, checked: true }])
    })
  }

  /**
   * Check the open tasks of `tasks`, or uncheck `tasks` when every one is
   * checked. A task that has the wanted state when its write starts is left
   * as it is.
   */
  toggle(tasks: readonly OpenTask[]): Promise<void> {
    return tasks.some((task) => !task.checked)
      ? this.complete(tasks)
      : this.#apply(tasks, ({ taskId }) => [{ kind: 'toggle', taskId, checked: false }])
  }

  /**
   * Remove `tasks` from their notes. Nested items move up.
   */
  remove(tasks: readonly OpenTask[]): Promise<void> {
    return this.#apply(tasks, ({ taskId }) => [{ kind: 'remove', taskId }])
  }

  /**
   * Turn `tasks` into plain bullets: they stay in their notes and leave the rows.
   */
  convert(tasks: readonly OpenTask[]): Promise<void> {
    return this.#apply(tasks, ({ taskId }) => [{ kind: 'toBullet', taskId }])
  }

  /**
   * Set the due date of `tasks` to `isoDate`, or clear it for `null`.
   */
  schedule(tasks: readonly OpenTask[], isoDate: string | null): Promise<void> {
    return this.#apply(tasks, ({ taskId }, markdown) => [
      { kind: 'setMarkdown', taskId, markdown: withDraftDueDate(markdown, isoDate) },
    ])
  }

  /**
   * Archive: no checked task stays in the active list. The tasks stay checked in their notes.
   */
  archive(): void {
    this.#deps.store().archive()
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
    return store.batch(() => {
      const replaced = store.findNewTask(task.taskId)
      void this.commit(task)
      const kept = store.rows(task.notePath).some((row) => row.taskId === task.taskId)
      return this.#addNewTask(task, kept ? task.taskId : (replaced?.after ?? null))
    })
  }

  /**
   * Toggle the task at the address `locator` in the note at `notePath`. The
   * rows take the tasks the write left. Rejects when the write fails.
   */
  async toggleAt(notePath: string, locator: TaskLocator): Promise<void> {
    const { generation } = requireGraphSession(this.#deps.graphSession)
    const store = this.#deps.store()
    const result = await this.write(generation, notePath, [
      { kind: 'toggle', task: toTaskLocator(locator) },
    ])
    store.landCommit(notePath, result, null)
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
    return this.#deps.store().addNewTask(target, after, this.#deps.clock.now())
  }

  /**
   * Save the text typed into each of `tasks`, then apply the ops that
   * `opsFor` gives for the task and its Markdown, in one write per note.
   */
  #apply(
    tasks: readonly OpenTask[],
    opsFor: (task: OpenTask, markdown: string) => readonly TaskItemOp[],
  ): Promise<void> {
    const { session } = this.#deps.graphSession.get()
    if (session === null) {
      return Promise.resolve()
    }
    const store = this.#deps.store()
    const writes = store.batch(() => {
      const byNote = new Map<string, TaskOp[]>()
      for (const task of tasks) {
        const ops = this.#takeOps(store, task, opsFor)
        if (ops.length > 0) {
          byNote.set(task.notePath, [...(byNote.get(task.notePath) ?? []), ...ops])
        }
      }
      return [...byNote].map(([notePath, ops]) => this.#queue(session, store, notePath, ops))
    })
    return Promise.all(writes).then(noop)
  }

  /**
   * The ops of one command for one task, with the text typed into it.
   */
  #takeOps(
    store: TaskStore,
    task: OpenTask,
    opsFor: (task: OpenTask, markdown: string) => readonly TaskItemOp[],
  ): TaskOp[] {
    const { taskId } = task
    const text = store.takeText(task)
    if (text.insert !== undefined) {
      const markdown = text.markdown.trim()
      const ops = markdown === '' ? [] : opsFor(task, markdown)
      // A new task with no text, or one that is removed, is dropped: nothing is written.
      if (markdown === '' || ops.some((op) => op.kind === 'remove')) {
        return []
      }
      const rewrite = ops.findLast((op) => op.kind === 'setMarkdown')
      return [
        {
          ...text.insert,
          markdown: rewrite?.markdown ?? markdown,
          checked: ops.some((op) => op.kind === 'toggle' && op.checked),
          bullet: ops.some((op) => op.kind === 'toBullet'),
        },
      ]
    }
    const edit = resolveTaskEdit(text.base, text.markdown)
    // A task whose text was cleared is removed, whatever the command.
    if (edit.type === 'delete') {
      return [{ kind: 'remove', taskId }]
    }
    return edit.type === 'commit'
      ? [{ kind: 'setMarkdown', taskId, markdown: edit.content }, ...opsFor(task, edit.content)]
      : [...opsFor(task, text.base)]
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
    let pending = store.begin(notePath, ops)
    const run = async (): Promise<void> => {
      pending = store.fold(pending)
      try {
        const result = session.signal.aborted
          ? null
          : await this.#writeOps(session, store, notePath, pending.ops)
        if (result === null) {
          store.fail(pending)
        } else {
          store.landCommit(notePath, result, pending)
        }
      } catch (cause) {
        store.fail(pending)
        if (!session.signal.aborted) {
          this.#report(cause)
        }
      }
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
      store.landPaths(await this.#deps.reader.readPathsOnce([notePath]), [notePath])
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
                : { kind: 'contextEnd', task: toTaskLocator(anchor) },
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
      const task = toTaskLocator(row)
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
