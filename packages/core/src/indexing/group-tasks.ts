import type { OpenTask } from './queries'

/**
 * Grouping for the Tasks view (Plan 18), faithful to V1's `task-view.ts`: open
 * tasks split into date buckets — **Current / Overdue / Upcoming** in that
 * display order — followed by one section per regular (dateless) note. A task's
 * date is its source note's daily date (V1's explicit `[[date]]` scheduling is
 * dropped), so the buckets are symmetric: a task in a past daily note is
 * overdue, today's is current, a future daily note's is upcoming, and a task in
 * a regular note groups under that note's title.
 *
 * Lives in core (not the desktop view) so the same grouping serves any surface —
 * the desktop list today, a `reflect tasks` CLI later — without re-deriving it.
 * Pure: the caller supplies `today`.
 */

/** A date bucket (tasks aggregated across daily notes) or a single regular note. */
export type TaskGroupKind = 'current' | 'overdue' | 'upcoming' | 'note'

export interface TaskGroup {
  kind: TaskGroupKind
  /** Section heading — the bucket name, or (for `note` groups) the note's title. */
  label: string
  /** The note a `note` group's header opens; null for the date buckets. */
  notePath: string | null
  tasks: OpenTask[]
}

/** Within a date bucket: oldest daily note first, then document order. */
function compareDated(left: OpenTask, right: OpenTask): number {
  // Both carry a dailyDate here, and ISO `YYYY-MM-DD` sorts chronologically.
  if (left.dailyDate !== right.dailyDate) {
    return (left.dailyDate ?? '') < (right.dailyDate ?? '') ? -1 : 1
  }
  return left.markerOffset - right.markerOffset
}

/**
 * Order the per-note groups: pinned notes first (by explicit `pinnedOrder`, bare
 * `pinned: true` last), then by most-recently edited, then by path for a stable
 * tiebreak. Each group's note metadata is shared by all its tasks, so the first
 * task carries the sort key.
 */
function compareNoteGroups(left: TaskGroup, right: TaskGroup): number {
  const first = left.tasks[0]
  const second = right.tasks[0]
  if (first.isPinned !== second.isPinned) {
    return second.isPinned - first.isPinned // pinned (1) before unpinned (0)
  }
  if (first.isPinned === 1) {
    const leftOrder = first.pinnedOrder
    const rightOrder = second.pinnedOrder
    if (leftOrder !== null && rightOrder !== null && leftOrder !== rightOrder) {
      return leftOrder - rightOrder
    }
    if ((leftOrder === null) !== (rightOrder === null)) {
      return leftOrder === null ? 1 : -1 // numbered pins before bare ones
    }
  }
  if (first.updatedAt !== second.updatedAt) {
    return second.updatedAt - first.updatedAt // most recent first
  }
  return first.notePath < second.notePath ? -1 : first.notePath > second.notePath ? 1 : 0
}

/**
 * Group open tasks for the Tasks view. `today` is an ISO `YYYY-MM-DD` date (the
 * app's local day). Empty buckets are omitted; the result is ordered
 * Current → Overdue → Upcoming → per-note. Pure and self-sorting, so it does not
 * depend on the order the index read returns.
 */
export function groupTasks(tasks: readonly OpenTask[], today: string): TaskGroup[] {
  const current: OpenTask[] = []
  const overdue: OpenTask[] = []
  const upcoming: OpenTask[] = []
  const byNote = new Map<string, OpenTask[]>()

  for (const task of tasks) {
    if (task.dailyDate === null) {
      const group = byNote.get(task.notePath)
      if (group === undefined) {
        byNote.set(task.notePath, [task])
      } else {
        group.push(task)
      }
    } else if (task.dailyDate < today) {
      overdue.push(task)
    } else if (task.dailyDate > today) {
      upcoming.push(task)
    } else {
      current.push(task)
    }
  }

  const dateGroups: TaskGroup[] = []
  if (current.length > 0) {
    dateGroups.push({ kind: 'current', label: 'Current', notePath: null, tasks: current.sort(compareDated) })
  }
  if (overdue.length > 0) {
    dateGroups.push({ kind: 'overdue', label: 'Overdue', notePath: null, tasks: overdue.sort(compareDated) })
  }
  if (upcoming.length > 0) {
    dateGroups.push({ kind: 'upcoming', label: 'Upcoming', notePath: null, tasks: upcoming.sort(compareDated) })
  }

  const noteGroups: TaskGroup[] = [...byNote.values()]
    .map((noteTasks) => ({
      kind: 'note' as const,
      label: noteTasks[0].noteTitle,
      notePath: noteTasks[0].notePath,
      tasks: noteTasks.sort((left, right) => left.markerOffset - right.markerOffset),
    }))
    .sort(compareNoteGroups)

  return [...dateGroups, ...noteGroups]
}
