import { groupTasks, type Task, type TaskGroup } from '@reflect/core'
import type { TaskFilters } from '@/lib/tasks/task-filters.ts'

/** Keep only the groups the active filters allow (V1's per-bucket toggles). */
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
  /** The store's list: open tasks, this session's completed tasks, and the history when archived is on. */
  readonly tasks: readonly Task[]
  readonly filters: TaskFilters
  /** The search text, already trimmed and lowercased (empty = no filter). */
  readonly needle: string
  /** Today's ISO `YYYY-MM-DD` date. */
  readonly today: string
}

function taskMatchesNeedle(task: Task, needle: string): boolean {
  return [task.displayText, task.noteTitle, ...task.breadcrumbs].some((text) =>
    text.toLowerCase().includes(needle),
  )
}

/** The Tasks list every surface renders: searched, grouped, and narrowed to the buckets the filters allow. */
export function composeVisibleTaskGroups({
  tasks,
  filters,
  needle,
  today,
}: TaskListSources): TaskGroup[] {
  const matched = needle ? tasks.filter((task) => taskMatchesNeedle(task, needle)) : tasks
  return visibleGroups(groupTasks(matched, today), filters)
}
