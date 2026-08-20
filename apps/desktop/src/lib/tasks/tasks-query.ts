import { queryOptions } from '@tanstack/react-query'
import { getCompletedTasks, getOpenTasks } from '@reflect/core'
import { queryKeys } from '@/lib/query-client'

/**
 * The TanStack Query key for the open-tasks list, scoped to the graph root so a
 * graph switch never serves the previous graph's rows. Shared by the screen
 * (which reads it) and a task row (which optimistically updates it on
 * completion), so the two can't drift.
 */
export const createOpenTasksQueryOptions = (graphRoot: string | undefined) =>
  queryOptions({
    queryKey: queryKeys.index.openTasks(graphRoot),
    queryFn: getOpenTasks,
  })

/**
 * The query options for the completed-tasks list (the "show archived" surface),
 * scoped like {@link createOpenTasksQueryOptions}. Shared so completing a task
 * can move its row from the open cache into this one optimistically rather than
 * letting it vanish until the refetch.
 */
export const createCompletedTasksQueryOptions = (graphRoot: string | undefined) =>
  queryOptions({
    queryKey: queryKeys.index.completedTasks(graphRoot),
    queryFn: getCompletedTasks,
  })
