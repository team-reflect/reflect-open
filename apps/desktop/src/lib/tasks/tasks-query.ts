import { INDEX_QUERY_SCOPE } from '@/lib/query-client'

/**
 * The TanStack Query key for the open-tasks list, scoped to the graph root so a
 * graph switch never serves the previous graph's rows. Shared by the screen
 * (which reads it) and a task row (which optimistically updates it on
 * completion), so the two can't drift.
 */
export function tasksQueryKey(graphRoot: string | undefined): readonly [string, string | undefined, 'tasks'] {
  return [INDEX_QUERY_SCOPE, graphRoot, 'tasks']
}

/**
 * The query key for the completed-tasks list (the "show archived" surface),
 * scoped like {@link tasksQueryKey}. Shared so completing a task can move its row
 * from the open cache into this one optimistically rather than letting it vanish
 * until the refetch.
 */
export function completedTasksQueryKey(
  graphRoot: string | undefined,
): readonly [string, string | undefined, 'tasks-completed'] {
  return [INDEX_QUERY_SCOPE, graphRoot, 'tasks-completed']
}
