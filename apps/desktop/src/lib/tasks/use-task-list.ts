import { useMemo, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getCompletedTasks, getOpenTasks, type Task, type TaskStore } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useTaskStore } from '@/lib/tasks/task-store.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

export interface TaskList {
  store: TaskStore | null
  /** False until a graph is open and the bridge is ready; the queries wait. */
  enabled: boolean
  /** The rows to show: open tasks, this session's completed tasks, and the history when `archived`. */
  tasks: Task[]
  /** True once every query the list needs has answered. */
  ready: boolean
  isError: boolean
  /** Completed in this session and not archived yet. */
  recentCount: number
}

/** The Tasks list both screens render: the index queries with the store's changes applied. */
export function useTaskList(archived: boolean): TaskList {
  const { graph } = useGraph()
  const enabled = useBridgeReady() && graph !== null
  const store = useTaskStore()
  const version = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.snapshot ?? zero)
  const open = useQuery({
    queryKey: queryKeys.index.openTasks(graph?.root),
    queryFn: getOpenTasks,
    enabled,
  })
  const completed = useQuery({
    queryKey: queryKeys.index.completedTasks(graph?.root),
    queryFn: getCompletedTasks,
    enabled: enabled && archived,
  })
  const tasks = useMemo(
    () => (store && open.data ? store.list(open.data, archived ? completed.data : undefined) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` tracks the store's changes
    [store, version, open.data, completed.data, archived],
  )
  return {
    store,
    enabled,
    tasks,
    ready: open.data !== undefined && (!archived || completed.data !== undefined),
    // The completed error only counts while archived is on: TanStack keeps the
    // last error on the disabled query.
    isError: open.isError || (archived && completed.isError),
    recentCount: store ? tasks.filter((task) => store.isRecent(task)).length : 0,
  }
}

const noSubscribe = () => () => {}
const zero = () => 0
