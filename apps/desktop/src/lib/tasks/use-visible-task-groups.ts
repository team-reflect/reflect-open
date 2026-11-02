import { useEffect, useMemo } from 'react'
import {
  composeVisibleTaskGroups,
  type OpenTask,
  type TaskFilters,
  type TaskGroup,
} from '@reflect/core'
import { useRecentlyCompleted } from '@/lib/tasks/recently-completed.ts'
import { useStore } from '@/lib/use-store.ts'
import { useGraphInfo } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

export interface VisibleTaskGroups {
  /**
   * The task groups to render, in order.
   */
  readonly groups: TaskGroup[]
  /**
   * This session's completed tasks, still showing struck until archived.
   */
  readonly recentlyCompleted: readonly OpenTask[]
  /**
   * Whether a read that the list needs failed.
   */
  readonly isError: boolean
  /**
   * Whether every read that the list needs has arrived.
   */
  readonly ready: boolean
}

/**
 * The visible task groups of the open graph, read from `TaskService` and
 * filtered by `filters` and `needle`. Reads the completed tasks while
 * `filters.archived` is on.
 */
export function useVisibleTaskGroups(
  filters: TaskFilters,
  needle: string,
  today: string,
): VisibleTaskGroups {
  const graph = useGraphInfo()
  const { tasks: taskService } = useCoreServices()
  const { open, completed, openFailed, completedFailed } = useStore(taskService)
  useEffect(
    () => (filters.archived ? taskService.includeCompleted() : undefined),
    [taskService, filters.archived],
  )

  // Either read failing surfaces the alert — a failed completed read must not
  // leave `ready` stuck (and the list blank) just because its data never arrived.
  // The completed error only counts while archived is on: the service keeps the
  // last error of a list it no longer reads, so turning archived off must clear it.
  const isError = openFailed || (filters.archived && completedFailed)
  // When archived is on, the list merges open + completed, so the empty state
  // must wait for both — else a graph with only completed tasks flashes "No
  // tasks to show." while the completed query is still loading.
  const ready = open !== undefined && (!filters.archived || completed !== undefined)

  // This session's completed tasks, still showing struck until archived —
  // reconciled against the open read so a task reopened at its source note
  // sheds its struck shadow instead of masking the live row.
  const recentlyCompleted = useRecentlyCompleted(graph?.root ?? null, open)

  const groups = useMemo(
    () => composeVisibleTaskGroups({ open, completed, recentlyCompleted, filters, needle, today }),
    [open, completed, recentlyCompleted, filters, needle, today],
  )

  return { groups, recentlyCompleted, isError, ready }
}
