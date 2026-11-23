import { groupTasks, type TaskGroup } from './group-tasks.ts'
import type { OpenTask } from './open-task.ts'

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
   * The checked tasks that still show in the active list until archived.
   */
  readonly struck: readonly OpenTask[]
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
 * The Tasks list every surface renders (Plan 18): the open rows and the
 * struck rows, plus every completed row with archived on, searched, grouped
 * ({@link groupTasks}) and narrowed to the buckets the filters allow. Shared
 * by the desktop screen and the mobile Tasks tab. A task has one row, so a
 * struck row that the completed list holds too shows once.
 */
export function composeVisibleTaskGroups({
  open,
  completed,
  struck,
  filters,
  needle,
  today,
}: TaskListSources): TaskGroup[] {
  if (open === undefined) {
    return []
  }
  const checked = filters.archived ? new Set([...(completed ?? []), ...struck]) : struck
  const all = [...open, ...checked]
  const matched = needle ? all.filter((task) => taskMatchesNeedle(task, needle)) : all
  return visibleGroups(groupTasks(matched, today), filters)
}
