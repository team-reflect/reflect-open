import type { MarkdownAstPath } from '@meowdown/markdown'
import type { NoteTasks, TaskRead } from '@reflect/types'
import type { DatabaseService } from '../indexing/database-service.ts'
import type { CommandArgs } from '../ipc/ipc-service.ts'
import {
  encodeTaskPath,
  isSameTaskPath,
  renderInlineText,
  type TaskEdit,
  type TaskEditItem,
  type TaskMove,
  type TaskSnapshot,
} from '../markdown/index.ts'
import type { OpenTask } from '../tasks/open-task.ts'
import type { TaskWriteResult } from '../tasks/task-store.ts'

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
 * Stands in for the index and the note files behind a `TaskCommands` whose
 * `write` a test replaces. It answers the `index_tasks` reads of
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
   * The result of applying `edits` to the tasks of `notePath` it last served.
   * A new task lands as a root item after every other task.
   */
  write(notePath: string, edits: readonly TaskEdit[]): TaskWriteResult {
    const before = this.#notes.get(notePath) ?? []
    const moved = before.map((from): TaskMove => {
      const to = edits.reduce<TaskSnapshot | null>((task, edit) => {
        return edit.kind !== 'insert' && hasPath(from, edit.task.astPath)
          ? applyItemEdit(task, edit)
          : task
      }, from)
      return { from, to }
    })
    let next = Math.max(-1, ...before.map((task) => task.astPath[0] ?? 0)) + 1
    const inserted = edits.flatMap((edit): TaskSnapshot[] => {
      if (edit.kind !== 'insert') {
        return []
      }
      const astPath = [next]
      next += 1
      return [
        {
          astPath,
          markdown: edit.markdown.trim(),
          breadcrumbs: [],
          checked: edit.checked === true,
        },
      ]
    })
    const tasks = [...moved.flatMap((move) => (move.to === null ? [] : [move.to])), ...inserted]
    const baseRevision = this.#revisions.get(notePath) ?? ''
    const revision = `${baseRevision}+`
    this.#seq += 1
    this.#notes.set(notePath, tasks)
    this.#revisions.set(notePath, revision)
    return {
      source: '',
      baseRevision,
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
      const tasks = (this.#notes.get(notePath) ?? []).filter((task) => !hasPath(task, astPath))
      this.#notes.set(notePath, [...tasks, { astPath, markdown, breadcrumbs, checked }])
      this.#revisions.set(notePath, revision)
    }
  }
}

function applyItemEdit(task: TaskSnapshot | null, edit: TaskEditItem): TaskSnapshot | null {
  if (task === null) {
    return null
  }
  switch (edit.kind) {
    case 'toggle': {
      return { ...task, checked: !task.checked }
    }
    case 'setMarkdown': {
      return { ...task, markdown: edit.markdown.trim() }
    }
    case 'remove':
    case 'toBullet': {
      return null
    }
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
