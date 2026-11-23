import type { MarkdownAstPath } from '@meowdown/markdown'
import type { NoteTasks, TaskRead } from '@reflect/types'
import type { DatabaseService } from '../indexing/database-service.ts'
import type { CommandArgs } from '../ipc/ipc-service.ts'
import {
  encodeTaskPath,
  isSameTaskPath,
  renderInlineText,
  type TaskMove,
  type TaskSnapshot,
} from '../markdown/index.ts'
import type { OpenTask } from '../tasks/open-task.ts'
import type { InsertedTask, TaskAction, TaskRef, TaskWriteResult } from '../tasks/task-service.ts'

/**
 * An open-task row with sensible defaults for tests; override only what a
 * case needs. `text` tracks `markdown` unless a case pins it explicitly.
 */
export function makeOpenTask(overrides: Partial<OpenTask> = {}): OpenTask {
  const markdown = overrides.markdown ?? overrides.text ?? 'do it'
  const notePath = overrides.notePath ?? 'notes/n.md'
  const astPath = overrides.astPath ?? [0]
  return {
    taskId: `${notePath}:${encodeTaskPath(astPath)}`,
    notePath: 'notes/n.md',
    revision: '',
    astPath: [0],
    markdown,
    checked: false,
    text: renderInlineText(markdown),
    breadcrumbs: [],
    noteTitle: 'N',
    dueDate: null,
    dailyDate: null,
    isPinned: false,
    pinnedOrder: null,
    updatedAt: 0,
    ...overrides,
  }
}

function hasPath(task: TaskSnapshot, astPath: MarkdownAstPath): boolean {
  return isSameTaskPath(task.astPath, astPath)
}

/**
 * Stands in for the index and the note files behind a `TaskService` whose
 * write methods a test replaces. It answers the `index_tasks` reads of
 * `database` with the rows the test supplies, and it makes the result of a
 * write over the tasks it last served. A read that started before a write
 * carries an older index seq than the write.
 */
export class TestTaskIndex {
  readonly #notes = new Map<string, TaskSnapshot[]>()
  readonly #revisions = new Map<string, string>()
  /**
   * Counts the writes: a read returns the count at its start as its index seq.
   */
  #seq = 0

  constructor(
    database: DatabaseService,
    readOpen: () => Promise<OpenTask[]>,
    readCompleted: () => Promise<OpenTask[]>,
  ) {
    const read = database.read.bind(database)
    database.read = async (command, args) => {
      if (command !== 'index_tasks') {
        return await read(command, args)
      }
      const { checked, paths } = args as CommandArgs<'index_tasks'>
      const seq = this.#seq
      const rows = [
        ...(checked === true ? [] : await readOpen()),
        ...(checked === false ? [] : await readCompleted()),
      ].filter((row) => paths === null || paths.includes(row.notePath))
      this.#serve(rows, checked, paths)
      return toTaskRead(rows, seq)
    }
  }

  /**
   * The result of applying `actions` to `task`, with every other task in its place.
   */
  write(task: TaskRef, actions: readonly TaskAction[]): TaskWriteResult {
    const before = this.#tasksOf(task.notePath)
    const moved = before.map((from): TaskMove => {
      const to = hasPath(from, task.astPath) ? actions.reduce(applyAction, from) : from
      return { from, to }
    })
    return this.#land(task, moved, [])
  }

  /**
   * The result of an insert that added `created` and moved the other tasks as `moved` says.
   */
  insert(notePath: string, created: TaskSnapshot, moved: readonly TaskMove[] = []): InsertedTask {
    const before = this.#tasksOf(notePath)
    const moves = before.map((from): TaskMove => {
      const move = moved.find((candidate) => hasPath(candidate.from, from.astPath))
      return move ?? { from, to: from }
    })
    const revision = this.#revisions.get(notePath) ?? ''
    return { ...this.#land({ notePath, revision }, moves, [created]), created }
  }

  /**
   * The result of an insert after `task` that added `created`, resolved the
   * draft `content` of `task`, and moved the other tasks as `moved` says.
   */
  continue(
    task: TaskRef,
    content: string | null,
    created: TaskSnapshot,
    moved: readonly TaskMove[] = [],
  ): InsertedTask {
    const actions: TaskAction[] =
      content === null
        ? []
        : content === ''
          ? [{ kind: 'remove' }]
          : [{ kind: 'setMarkdown', markdown: content }]
    const moves = this.#tasksOf(task.notePath).map((from): TaskMove => {
      const move = moved.find((candidate) => hasPath(candidate.from, from.astPath))
      const to = move === undefined ? from : move.to
      return { from, to: hasPath(from, task.astPath) ? actions.reduce(applyAction, to) : to }
    })
    return { ...this.#land(task, moves, [created]), created }
  }

  #tasksOf(notePath: string): TaskSnapshot[] {
    return this.#notes.get(notePath) ?? []
  }

  #land(
    note: Pick<TaskRef, 'notePath' | 'revision'>,
    moved: readonly TaskMove[],
    inserted: readonly TaskSnapshot[],
  ): TaskWriteResult {
    const tasks = [...moved.flatMap((move) => (move.to === null ? [] : [move.to])), ...inserted]
    const revision = `${note.revision}+`
    this.#seq += 1
    this.#notes.set(note.notePath, tasks)
    this.#revisions.set(note.notePath, revision)
    return {
      source: '',
      baseRevision: note.revision,
      revision,
      moved,
      inserted,
      tasks,
      merged: false,
      indexSeq: this.#seq,
      updatedAt: 0,
    }
  }

  #serve(
    rows: readonly OpenTask[],
    checked: boolean | null,
    paths: readonly string[] | null,
  ): void {
    for (const [path, tasks] of this.#notes) {
      if (paths === null || paths.includes(path)) {
        this.#notes.set(
          path,
          tasks.filter((task) => checked !== null && task.checked !== checked),
        )
      }
    }
    for (const { notePath, revision, astPath, markdown, breadcrumbs, checked } of rows) {
      const tasks = this.#tasksOf(notePath).filter((task) => !hasPath(task, astPath))
      this.#notes.set(notePath, [...tasks, { astPath, markdown, breadcrumbs, checked }])
      this.#revisions.set(notePath, revision)
    }
  }
}

function applyAction(task: TaskSnapshot | null, action: TaskAction): TaskSnapshot | null {
  if (task === null) {
    return null
  }
  switch (action.kind) {
    case 'toggle':
      return { ...task, checked: !task.checked }
    case 'setMarkdown':
      return { ...task, markdown: action.markdown.trim() }
    case 'remove':
    case 'toBullet':
      return null
  }
}

/**
 * The index read at `seq` that returns `rows`: the rows grouped by note.
 */
function toTaskRead(rows: readonly OpenTask[], seq: number): TaskRead {
  const notes = new Map<string, NoteTasks>()
  for (const row of rows) {
    const note = notes.get(row.notePath) ?? {
      path: row.notePath,
      hash: row.revision,
      title: row.noteTitle,
      dailyDate: row.dailyDate,
      isPinned: row.isPinned,
      pinnedOrder: row.pinnedOrder,
      updatedAt: row.updatedAt,
      tasks: [],
    }
    note.tasks.push({
      astPath: [...row.astPath],
      markdown: row.markdown,
      breadcrumbs: [...row.breadcrumbs],
      checked: row.checked,
    })
    notes.set(row.notePath, note)
  }
  return { seq, notes: [...notes.values()] }
}
