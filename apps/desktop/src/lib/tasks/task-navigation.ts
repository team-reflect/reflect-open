import {
  dailyPath,
  taskDateBucket,
  type Task,
  type TaskGroup,
  type TaskStore,
  type TaskTarget,
} from '@reflect/core'

/** Today's daily note as a target: V1's "add to Today" and the Current bucket. */
export function todaysDailyTarget(today: string): TaskTarget {
  return {
    notePath: dailyPath(today),
    noteTitle: today,
    dailyDate: today,
    isPinned: false,
    pinnedOrder: null,
  }
}

function noteTarget(task: Task): TaskTarget {
  return {
    notePath: task.notePath,
    noteTitle: task.noteTitle,
    dailyDate: task.dailyDate,
    isPinned: task.isPinned,
    pinnedOrder: task.pinnedOrder,
  }
}

/**
 * Where a group's "+ Add" adds a task (V1): Current adds to today's daily, a
 * note group to that note. The aggregate Overdue and Upcoming buckets span
 * many notes and show no add button.
 */
export function addTargetForGroup(group: TaskGroup, today: string): TaskTarget | null {
  if (group.kind === 'current') return todaysDailyTarget(today)
  const first = group.tasks[0]
  return group.kind === 'note' && first !== undefined ? noteTarget(first) : null
}

/**
 * Return or Enter on `task` (V1 continuous entry): save its draft, then add
 * the next task and return it to select. A task with breadcrumb context is
 * continued inside that context, right below it; otherwise V1's bucket rule
 * decides, and the aggregate buckets return null. Without a task, add to
 * today's daily.
 */
export function continueFrom(store: TaskStore, task: Task | undefined, today: string): Task | null {
  if (task === undefined) return store.create(todaysDailyTarget(today))
  const saved = store.commitDraft(task)
  if (saved && saved.breadcrumbs.length > 0 && saved.text.trim() !== '') {
    return store.create({ ...noteTarget(saved), breadcrumbs: saved.breadcrumbs }, saved)
  }
  switch (taskDateBucket(task, today)) {
    case 'current':
      return store.create(todaysDailyTarget(today))
    case 'note':
      return store.create(noteTarget(task))
    default:
      return null
  }
}

/**
 * The key to select after deleting `task` (V1's `selectPreviousTask`): the row
 * just above it, or, when it was the first, the row just below. Null when it
 * was the only row.
 */
export function previousTaskKey(ordered: readonly Task[], task: Task): string | null {
  const index = ordered.findIndex((row) => row.key === task.key)
  if (index === -1) return null
  const previous = ordered[index === 0 ? 1 : index - 1]
  return previous ? previous.key : null
}

/** Bring the row carrying `key` into view without jumping when it is already visible. */
export function scrollTaskIntoView(root: HTMLElement | null, key: string): void {
  const selector = `[data-task-key="${key.replaceAll('"', String.raw`\"`)}"]`
  root?.querySelector(selector)?.scrollIntoView({ block: 'nearest' })
}
