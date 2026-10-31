import { dailyPath } from '../graph/paths.ts'
import type { OpenTask } from './open-task.ts'
import { getTaskKey, isSameTask } from './task-identity.ts'
import type { InsertTaskTarget } from './task-insert-target.ts'

/**
 * Shared Tasks-view navigation helpers (Plan 18, V1 parity). The keyboard
 * handler and the inline editor both move the selection between rows and add
 * tasks, so the small bits of logic they have in common live here — one
 * definition, no drift between the editing and not-editing paths.
 */

/**
 * Today's daily note as an insert target — V1's "add to Today" / Current bucket.
 */
export function todaysDailyTarget(today: string): InsertTaskTarget {
  return {
    notePath: dailyPath(today),
    noteTitle: today,
    dailyDate: today,
    isPinned: false,
    pinnedOrder: null,
  }
}

/**
 * The key to select after deleting `task` (V1's `selectPreviousTask`): the row
 * just above it, or — when it was the first — the row just below (which becomes
 * the new first). `null` when it was the only row, so the caller clears.
 */
export function previousTaskKey(ordered: readonly OpenTask[], task: OpenTask): string | null {
  const index = ordered.findIndex((row) => isSameTask(row, task))
  if (index === -1) {
    return null
  }
  const previous = ordered[index === 0 ? 1 : index - 1]
  return previous ? getTaskKey(previous) : null
}
