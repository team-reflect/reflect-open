import type { OpenTask } from './queries'

/**
 * Grouping for the Tasks view (Plan 18), faithful to V1's `task-view.ts`: open
 * tasks split into date buckets — **Current / Overdue / Upcoming** in that
 * display order — followed by one section per note that holds undated tasks.
 *
 * A task's date is its explicit **due date** when it has one — the first calendar
 * `[[YYYY-MM-DD]]` link inside the item (V1's "scheduling is association") — else
 * its source note's daily date. The buckets follow V1 exactly, and Overdue is
 * **asymmetric**: only an explicit due date in the past makes a task overdue. A
 * bare checkbox in a past daily note is *Current*, not Overdue — V1 treats an
 * un-rescheduled daily task as still current, not late. A task with no date at
 * all (no due date, in a regular note) groups under its note's title.
 *
 * Lives in core (not the desktop view) so the same grouping serves any surface —
 * the desktop list today, a `reflect tasks` CLI later — without re-deriving it.
 * Pure: the caller supplies `today` (an ISO `YYYY-MM-DD`, the app's local day).
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

const PUNCTUATION_RE = /[\p{P}\p{S}]/gu

function normalizedBreadcrumb(text: string): string {
  return text.replace(/\s+/g, '').replace(PUNCTUATION_RE, '')
}

/** Trim breadcrumb labels and hide a lone generic Tasks/Todo parent. */
export function visibleTaskBreadcrumbs(breadcrumbs: readonly string[]): string[] {
  const visible = breadcrumbs.map((text) => text.trim()).filter((text) => text.length > 0)
  if (visible.length !== 1) {
    return visible
  }
  return /^(?:task|todo)s?$/i.test(normalizedBreadcrumb(visible[0]!)) ? [] : visible
}

/** One consecutive run of task rows sharing the same parent outline labels. */
export interface TaskContext {
  readonly breadcrumbs: readonly string[]
  readonly tasks: readonly OpenTask[]
}

function haveSameBreadcrumbs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index])
}

/** Group consecutive task rows that share the same parent outline context. */
export function groupTaskContexts(tasks: readonly OpenTask[]): TaskContext[] {
  const contexts: { breadcrumbs: readonly string[]; tasks: OpenTask[] }[] = []

  for (const task of tasks) {
    const previous = contexts.at(-1)
    if (previous !== undefined && haveSameBreadcrumbs(previous.breadcrumbs, task.breadcrumbs)) {
      previous.tasks.push(task)
    } else {
      contexts.push({ breadcrumbs: task.breadcrumbs, tasks: [task] })
    }
  }

  return contexts
}

/** The date a task is bucketed by: its explicit due date, else its note's date. */
function effectiveDate(task: OpenTask): string | null {
  return task.dueDate ?? task.dailyDate
}

/**
 * Which bucket a single task falls in, by the same rules {@link groupTasks} uses
 * — so a caller (e.g. the view's Return-to-add, deciding which note a new task
 * joins) can place one task without rebuilding every group. `today` is an ISO
 * `YYYY-MM-DD`. `'note'` means undated (grouped under its source note).
 */
export function taskDateBucket(task: OpenTask, today: string): TaskGroupKind {
  const date = effectiveDate(task)
  if (date === null) {
    return 'note'
  }
  if (task.dueDate !== null && task.dueDate < today) {
    return 'overdue'
  }
  if (date > today) {
    return 'upcoming'
  }
  return 'current'
}

/** Within a date bucket: earliest effective date first, then document order. */
function compareDated(left: OpenTask, right: OpenTask): number {
  // Every task in a date bucket has an effective date; ISO `YYYY-MM-DD` sorts
  // chronologically. (The `?? ''` only satisfies the type — it never fires here.)
  const leftDate = effectiveDate(left) ?? ''
  const rightDate = effectiveDate(right) ?? ''
  if (leftDate !== rightDate) {
    return leftDate < rightDate ? -1 : 1
  }
  if (left.notePath !== right.notePath) {
    return left.notePath < right.notePath ? -1 : 1
  }
  return left.markerOffset - right.markerOffset
}

/**
 * Compare two notes by pin shelf precedence: pinned before unpinned, then
 * numbered pins (`pinned: <n>`, ascending) before bare `pinned: true`. Returns 0
 * when the two share a rank, leaving the caller's own tiebreak (recency, title)
 * to decide. This is the one JS expression of the order the sidebar's pinned list
 * encodes in SQL ({@link getPinnedNotes}), so the two can't drift.
 */
function comparePinPrecedence(
  left: Pick<OpenTask, 'isPinned' | 'pinnedOrder'>,
  right: Pick<OpenTask, 'isPinned' | 'pinnedOrder'>,
): number {
  if (left.isPinned !== right.isPinned) {
    return left.isPinned ? -1 : 1 // pinned before unpinned
  }
  if (!left.isPinned) {
    return 0 // both unpinned — no pin-derived order
  }
  const { pinnedOrder: leftOrder } = left
  const { pinnedOrder: rightOrder } = right
  if (leftOrder !== null && rightOrder !== null && leftOrder !== rightOrder) {
    return leftOrder - rightOrder
  }
  if ((leftOrder === null) !== (rightOrder === null)) {
    return leftOrder === null ? 1 : -1 // numbered pins before bare ones
  }
  return 0
}

/**
 * Order the per-note groups: pinned notes first ({@link comparePinPrecedence}),
 * then by most-recently edited, then by path for a stable tiebreak. Each group's
 * note metadata is shared by all its tasks, so the first task carries the sort key.
 */
function compareNoteGroups(left: TaskGroup, right: TaskGroup): number {
  // Groups are never built empty, so each has a first task carrying the sort key.
  const first = left.tasks[0]!
  const second = right.tasks[0]!
  const byPin = comparePinPrecedence(first, second)
  if (byPin !== 0) {
    return byPin
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
    const date = effectiveDate(task)
    if (date === null) {
      // No due date and no daily date — V1's "unscheduled": grouped by note.
      const group = byNote.get(task.notePath)
      if (group === undefined) {
        byNote.set(task.notePath, [task])
      } else {
        group.push(task)
      }
    } else if (task.dueDate !== null && task.dueDate < today) {
      // Overdue keys off the explicit due date ALONE (V1's asymmetry): a bare
      // task in a past daily note is not overdue — it lands in Current below.
      overdue.push(task)
    } else if (date > today) {
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
      // A `byNote` entry only exists once a task has been pushed into it.
      label: noteTasks[0]!.noteTitle,
      notePath: noteTasks[0]!.notePath,
      tasks: noteTasks.sort((left, right) => left.markerOffset - right.markerOffset),
    }))
    .sort(compareNoteGroups)

  return [...dateGroups, ...noteGroups]
}
