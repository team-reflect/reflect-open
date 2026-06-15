import { type OpenTask } from '@reflect/core'
import { sameTask, taskKey } from '@/lib/tasks/task-identity'
import { type InsertTaskTarget } from '@/lib/tasks/use-task-actions'

/**
 * Shared Tasks-view navigation helpers (Plan 18, V1 parity). The keyboard
 * handler and the inline editor both move the selection between rows, add tasks,
 * and keep the active row on screen, so the small bits of logic they have in
 * common live here — one definition, no drift between the editing and
 * not-editing paths.
 */

/** The note context a new task inherits when added next to `task` (V1: same note/group). */
export function insertTargetForTask(task: OpenTask): InsertTaskTarget {
  return {
    notePath: task.notePath,
    noteTitle: task.noteTitle,
    dailyDate: task.dailyDate,
    isPinned: task.isPinned,
    pinnedOrder: task.pinnedOrder,
  }
}

/**
 * The key to select after deleting `task` (V1's `selectPreviousTask`): the row
 * just above it, or — when it was the first — the row just below (which becomes
 * the new first). `null` when it was the only row, so the caller clears.
 */
export function previousTaskKey(ordered: readonly OpenTask[], task: OpenTask): string | null {
  const index = ordered.findIndex((row) => sameTask(row, task))
  if (index === -1) {
    return null
  }
  const previous = ordered[index === 0 ? 1 : index - 1]
  return previous ? taskKey(previous) : null
}

/**
 * Bring the row carrying `key` into view (V1 scrolls the selection on every
 * keyboard move). `block: 'nearest'` mirrors V1 — no jump when it's already
 * visible. A no-op when the row isn't mounted or `root` is gone.
 */
export function scrollTaskIntoView(root: HTMLElement | null, key: string): void {
  const selector = `[data-task-key="${key.replaceAll('"', '\\"')}"]`
  root?.querySelector(selector)?.scrollIntoView({ block: 'nearest' })
}
