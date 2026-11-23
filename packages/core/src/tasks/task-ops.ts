import type { MarkdownAstPath } from '@meowdown/markdown'
import { getTaskDueDate, renderInlineText } from '../markdown/index.ts'
import { TASKS_SECTION } from '../markdown/list-insert.ts'
import type { OpenTask } from './open-task.ts'
import type { InsertTaskTarget } from './task-insert-target.ts'

/**
 * A change to one existing task, named by its id.
 */
export type TaskItemOp =
  | { kind: 'toggle'; taskId: string }
  | { kind: 'setMarkdown'; taskId: string; markdown: string }
  | { kind: 'remove'; taskId: string }
  | { kind: 'toBullet'; taskId: string }

/**
 * A new task, with the id its row holds before and after the write.
 */
export interface TaskInsertOp {
  kind: 'insert'
  taskId: string
  /**
   * The note the task joins. A note with no row yet takes its row context from here.
   */
  note: InsertTaskTarget
  /**
   * The task whose list the new task ends, or `null` for the Tasks section of the note.
   */
  after: string | null
  markdown: string
  /**
   * The new task is written checked.
   */
  checked?: boolean | undefined
  /**
   * Epoch milliseconds when the op was made, to order the row of a note with no other row.
   */
  updatedAt: number
}

/**
 * A change to the tasks of one note that a write is about to make.
 */
export type TaskOp = TaskItemOp | TaskInsertOp

/**
 * The row fields that derive from a task's Markdown.
 */
function renderMarkdown(markdown: string): Pick<OpenTask, 'markdown' | 'text' | 'dueDate'> {
  return { markdown, text: renderInlineText(markdown), dueDate: getTaskDueDate(markdown) }
}

function isInside(path: MarkdownAstPath, parent: MarkdownAstPath): boolean {
  return path.length > parent.length && parent.every((index, i) => path[i] === index)
}

/**
 * The index a new row takes: after the list that `anchor` sits in, counted as
 * the rows that follow it under the same parent without a gap between
 * siblings.
 */
function findListEnd(rows: readonly OpenTask[], anchor: number): number {
  const parent = rows[anchor]!.astPath.slice(0, -1)
  let sibling = rows[anchor]!.astPath.at(-1) ?? 0
  let end = anchor + 1
  for (; end < rows.length; end += 1) {
    const path = rows[end]!.astPath
    const next = path[parent.length]
    if (!isInside(path, parent) || next === undefined || next > sibling + 1) {
      break
    }
    sibling = next
  }
  return end
}

function isInTasksSection(row: OpenTask): boolean {
  return row.breadcrumbs.some((label) => TASKS_SECTION.titles.includes(label))
}

function insertRow(rows: readonly OpenTask[], op: TaskInsertOp): readonly OpenTask[] {
  const anchor = op.after === null ? -1 : rows.findIndex((row) => row.taskId === op.after)
  const section = rows.findLastIndex(isInTasksSection)
  const index =
    anchor !== -1 ? findListEnd(rows, anchor) : section !== -1 ? section + 1 : rows.length
  const context = rows[anchor] ?? rows[section]
  const previous = rows[index - 1]
  const row: OpenTask = {
    ...op.note,
    taskId: op.taskId,
    updatedAt: op.updatedAt,
    revision: previous?.revision ?? '',
    astPath: previous?.astPath ?? [],
    breadcrumbs: context?.breadcrumbs ?? TASKS_SECTION.titles.slice(0, 1),
    checked: op.checked === true,
    ...renderMarkdown(op.markdown.trim()),
  }
  return [...rows.slice(0, index), row, ...rows.slice(index)]
}

/**
 * The rows of one note, in document order, as `op` leaves them. An op that
 * names no row changes nothing. A changed row keeps the address it has in the
 * note text the rows were read from. An inserted row has no address yet: it
 * carries the address of the row before it, and its place is a prediction
 * that the rows of the written note replace.
 */
export function applyTaskOp(rows: readonly OpenTask[], op: TaskOp): readonly OpenTask[] {
  switch (op.kind) {
    case 'toggle': {
      return rows.map((row) => (row.taskId === op.taskId ? { ...row, checked: !row.checked } : row))
    }
    case 'setMarkdown': {
      const rendered = renderMarkdown(op.markdown.trim())
      return rows.map((row) => (row.taskId === op.taskId ? { ...row, ...rendered } : row))
    }
    case 'remove':
    case 'toBullet': {
      return rows.filter((row) => row.taskId !== op.taskId)
    }
    case 'insert': {
      return insertRow(rows, op)
    }
  }
}
