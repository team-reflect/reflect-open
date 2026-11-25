import { useEffect, useMemo } from 'react'
import {
  composeVisibleTaskGroups,
  type OpenTask,
  type TaskFilters,
  type TaskGroup,
} from '@reflect/core'
import { useStore } from '@/lib/use-store.ts'
import { useCoreServices } from '@/services/services-provider.tsx'

interface VisibleTaskGroupsOptions {
  /**
   * The search text, trimmed and in lower case.
   */
  needle: string
  filters: TaskFilters
  /**
   * Today's ISO date.
   */
  today: string
}

interface VisibleTaskGroups {
  groups: TaskGroup[]
  /**
   * Whether every task the filters ask for is loaded.
   */
  ready: boolean
  /**
   * The tasks completed in this run and not archived yet.
   */
  struck: readonly OpenTask[]
  /**
   * Changes when the search text or the filters change.
   */
  resetKey: string
}

/**
 * The task groups a Tasks screen shows: the open tasks, with the completed
 * ones while the archived filter is on, searched, grouped, and filtered.
 */
export function useVisibleTaskGroups({
  needle,
  filters,
  today,
}: VisibleTaskGroupsOptions): VisibleTaskGroups {
  const { tasks: taskService } = useCoreServices()
  const { open, completed, struck } = useStore(taskService)
  useEffect(
    () => (filters.archived ? taskService.includeCompleted() : undefined),
    [taskService, filters.archived],
  )
  const ready = open !== undefined && (!filters.archived || completed !== undefined)
  const groups = useMemo(
    () => composeVisibleTaskGroups({ open, completed, struck, filters, needle, today }),
    [open, completed, struck, filters, needle, today],
  )
  const resetKey = useMemo(() => JSON.stringify([needle, filters]), [needle, filters])
  return { groups, ready, struck, resetKey }
}
