import { groupTasks, type TaskGroup } from './group-tasks.ts'
import type { OpenTask } from './open-task.ts'
import { getTaskKey, isSameTask } from './task-identity.ts'

/**
 * Which task groups the Tasks view shows (V1's task filter store). The five date
 * / pin buckets default on; `archived` (completed tasks) defaults off. Pinned vs
 * other distinguishes tasks in pinned notes from those in ordinary notes — the
 * two per-note group families V1 lets you toggle independently.
 */
export interface TaskFilters {
  pinned: boolean
  current: boolean
  overdue: boolean
  upcoming: boolean
  other: boolean
  archived: boolean
}

/**
 * Keep only the groups the active filters allow (V1's per-bucket toggles).
 */
export function visibleGroups(groups: TaskGroup[], filters: TaskFilters): TaskGroup[] {
  return groups.filter((group) => {
    switch (group.kind) {
      case 'current':
        return filters.current
      case 'overdue':
        return filters.overdue
      case 'upcoming':
        return filters.upcoming
      case 'note':
        return group.tasks[0]?.isPinned ? filters.pinned : filters.other
    }
  })
}

export interface TaskListSources {
  /**
   * The open tasks (`undefined` while loading).
   */
  readonly open: readonly OpenTask[] | undefined
  /**
   * The completed tasks, only read when `filters.archived` is on.
   */
  readonly completed: readonly OpenTask[] | undefined
  /**
   * This session's completed tasks, still showing struck until archived.
   */
  readonly recentlyCompleted: readonly OpenTask[]
  readonly filters: TaskFilters
  /**
   * The search text, already trimmed and lowercased (empty = no filter).
   */
  readonly needle: string
  /**
   * Today's ISO `YYYY-MM-DD` date.
   */
  readonly today: string
}

function taskMatchesNeedle(task: OpenTask, needle: string): boolean {
  return [task.text, task.markdown, task.noteTitle, ...task.breadcrumbs].some((text) => {
    return text.toLowerCase().includes(needle)
  })
}

/**
 * The Tasks list every surface renders (Plan 18): open rows merged with the
 * struck "completed" rows, searched, grouped ({@link groupTasks}) and narrowed to
 * the buckets the filters allow. Shared by the desktop screen and the mobile
 * Tasks tab so the two can't drift on the merge rules:
 *
 * - With archived on, the completed query is the full history — but a
 *   just-completed task may not be in it until the reindex refetches (and the
 *   query reloads blank when the filter first flips on), so the session set is
 *   unioned on top, deduped. With archived off, the session set is the only
 *   source of struck rows.
 * - Any open row also present struck is dropped from the open side — a refetch
 *   can briefly restore a just-completed task to the open cache before the
 *   reindex lands, and listing it both open and struck collides React keys.
 *   That shadow is only ever transient: a task genuinely reopened at its source
 *   note leaves the session set via `reconcileRecentlyCompleted` (its reindexed
 *   row carries a newer `updatedAt`), so the live open row takes over.
 */
export function composeVisibleTaskGroups({
  open,
  completed,
  recentlyCompleted,
  filters,
  needle,
  today,
}: TaskListSources): TaskGroup[] {
  if (open === undefined) {
    return []
  }
  const completedRows = filters.archived
    ? [
        ...(completed ?? []),
        ...recentlyCompleted.filter(
          (task) => !(completed ?? []).some((row) => isSameTask(row, task)),
        ),
      ]
    : recentlyCompleted
  const completedKeys = new Set(completedRows.map(getTaskKey))
  const all = [...open.filter((task) => !completedKeys.has(getTaskKey(task))), ...completedRows]
  const matched = needle ? all.filter((task) => taskMatchesNeedle(task, needle)) : all
  return visibleGroups(groupTasks(matched, today), filters)
}
