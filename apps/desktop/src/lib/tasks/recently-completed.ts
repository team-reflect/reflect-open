import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { withoutReopenedTasks, type OpenTask } from '@reflect/core'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * The React view of `TaskService`'s "recently completed" set (Plan 18) — V1's
 * middle state where a checked task keeps showing (struck) in the list until
 * you archive it. The set itself lives on the service.
 */

/**
 * The session's recently-completed tasks for `root` (empty for any other graph),
 * reconciled against the live open-tasks read: passing the open query's data in
 * is what lets a task reopened at its source note shed its struck shadow, so
 * every surface that renders the set gets that reconciliation for free.
 *
 * The returned view filters superseded rows **during render** — the very first
 * render with the fresh open data already shows the live row, leaving no frame
 * where the stale `[x]` shadow could still offer a doomed Reopen. The store
 * itself is pruned in an effect (`TaskService.reconcileRecentlyCompleted`) so
 * `hasRecentlyCompleted` and the Archive count catch up right after.
 */
export function useRecentlyCompleted(
  root: string | null,
  open: readonly OpenTask[] | undefined,
): readonly OpenTask[] {
  const { tasks } = useCoreServices()
  useEffect(() => {
    if (open !== undefined) {
      tasks.reconcileRecentlyCompleted(root, open)
    }
  }, [tasks, root, open])
  const getSnapshot = useCallback(() => tasks.getRecentlyCompleted(root), [tasks, root])
  const struck = useSyncExternalStore(tasks.subscribeRecentlyCompleted, getSnapshot)
  return useMemo(
    () => (open === undefined ? struck : withoutReopenedTasks(struck, open)),
    [struck, open],
  )
}
