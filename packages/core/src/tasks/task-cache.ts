import { renderInlineText } from '../markdown/index.ts'
import type { OpenTask } from './open-task.ts'
import { getTaskKey, isSameTask } from './task-identity.ts'

/**
 * Pure transforms over a cached task list ({@link OpenTask}[]), the optimistic
 * shapes the Tasks view applies before the reindex reconciles. Each takes the
 * current list (possibly `undefined` when a query isn't loaded) and returns the
 * next, leaving `undefined` untouched so a not-loaded completed list (archived
 * off) is a no-op. They identify rows by {@link isSameTask}, the same key the
 * React rows and the mutations use, so an optimistic edit can't target the wrong
 * row. Kept apart from the mutation hooks so they're unit-testable directly and
 * shared by every Tasks write — single-row and bulk alike.
 */

/**
 * Drop every row matching one of `tasks` from a cached list.
 */
export function withoutTasks(
  rows: readonly OpenTask[] | undefined,
  tasks: readonly OpenTask[],
): readonly OpenTask[] | undefined {
  return rows?.filter((row) => !tasks.some((task) => isSameTask(row, task)))
}

/**
 * The same task with its checkbox set to `checked`.
 */
export function withChecked(task: OpenTask, checked: boolean): OpenTask {
  return task.checked === checked ? task : { ...task, checked }
}

/**
 * Move `tasks` to the front of the completed list as checked, de-duping any
 * already present — the optimistic shape of completing them with archived on, so
 * the rows stay visible struck through instead of vanishing until the refetch.
 */
export function asCompleted(
  rows: readonly OpenTask[] | undefined,
  tasks: readonly OpenTask[],
): readonly OpenTask[] | undefined {
  if (rows === undefined) {
    return rows
  }
  const kept = rows.filter((row) => !tasks.some((task) => isSameTask(row, task)))
  return [...tasks.map((task) => withChecked(task, true)), ...kept]
}

/**
 * Move `tasks` into the open list as unchecked, de-duping any already present.
 * The open-tasks query is the primary Tasks view data source, so a not-yet-loaded
 * list materializes as just the reopened rows.
 */
export function asOpen(
  rows: readonly OpenTask[] | undefined,
  tasks: readonly OpenTask[],
): readonly OpenTask[] {
  const reopened = tasks.map((task) => withChecked(task, false))
  const reopenedKeys = new Set(reopened.map(getTaskKey))
  return [...(rows ?? []).filter((row) => !reopenedKeys.has(getTaskKey(row))), ...reopened]
}

/**
 * Rewrite one task's Markdown in a cached list before the reindex re-derives
 * it. The row keeps its place (the bucket only moves once the index re-reads
 * any due date) but shows the new text, with `text` carrying the *plain*
 * rendering (so search and the row label never see raw `[[…]]`/markup).
 */
export function withEditedTask(
  rows: readonly OpenTask[] | undefined,
  task: OpenTask,
  markdown: string,
): readonly OpenTask[] | undefined {
  const text = renderInlineText(markdown)
  return rows?.map((row) => (isSameTask(row, task) ? { ...row, markdown, text } : row))
}
