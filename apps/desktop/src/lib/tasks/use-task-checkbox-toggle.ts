import type { OpenTask } from '@reflect/core'
import { useTaskCheckboxAction } from '@/lib/tasks/use-task-checkbox-action'

/**
 * Toggle one task from the Tasks view checkbox (Plan 18), optimistically. Open
 * rows move to completed immediately; checked rows move back to open. The reindex
 * then reconciles it. A failed write rolls the row back and surfaces the reason
 * (stale index, or the note is busy) via the operations toast. `toggle` is a
 * no-op while a write is in flight or before a graph generation is available.
 *
 * The optimistic edit mirrors the real transition across BOTH task caches: open
 * rows are dropped from the open list and prepended to completed as checked;
 * checked rows are dropped from completed/recently-completed and appended to
 * open as unchecked. This goes through the shared
 * {@link useTaskCacheWriter}, the same path the bulk {@link useTaskActions} uses,
 * so a one-row completion and a bulk completion can't drift apart.
 *
 * Pulled out of {@link TaskRow} so the cache surgery stays testable apart from
 * rendering, and the row reads as plain markup.
 */
export function useTaskCheckboxToggle(task: OpenTask): { toggle: () => void; isPending: boolean } {
  const action = useTaskCheckboxAction()

  return {
    isPending: action.isPending,
    toggle: () => action.toggle(task),
  }
}
