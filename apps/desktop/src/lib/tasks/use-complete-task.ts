import { useMutation } from '@tanstack/react-query'
import { type OpenTask } from '@reflect/core'
import { toggleTask } from '@/lib/note-task'
import { forgetRecentlyCompleted, markRecentlyCompleted } from '@/lib/tasks/recently-completed'
import { asCompleted, withoutTasks } from '@/lib/tasks/task-cache'
import { taskKey } from '@/lib/tasks/task-identity'
import { useTaskCacheWriter } from '@/lib/tasks/use-task-cache'
import { useGraph } from '@/providers/graph-provider'

/**
 * Complete a task from the Tasks view (Plan 18), optimistically. The row moves
 * to its completed state immediately (so completing feels instant); the reindex
 * then reconciles it. A failed write rolls the row back and surfaces the reason
 * (stale index, or the note is busy) via the operations toast. `complete` is a
 * no-op while a write is in flight or before a graph generation is available.
 *
 * The optimistic edit mirrors the real transition across BOTH task caches —
 * dropping the row from the open list and, when the completed ("show archived")
 * list is loaded, prepending it there as checked — via the shared
 * {@link useTaskCacheWriter}, the same path the bulk {@link useTaskActions} uses,
 * so a one-row completion and a bulk completion can't drift apart.
 *
 * Pulled out of {@link TaskRow} so the cache surgery stays testable apart from
 * rendering, and the row reads as plain markup.
 */
export function useCompleteTask(task: OpenTask): { complete: () => void; isPending: boolean } {
  const { graph } = useGraph()
  const cache = useTaskCacheWriter()

  const root = graph?.root ?? null
  const mutation = useMutation({
    mutationFn: (generation: number) => toggleTask(task, generation),
    onMutate: async () => {
      const snapshot = await cache.snapshot()
      cache.patch(
        (rows) => withoutTasks(rows, [task]),
        (rows) => asCompleted(rows, [task]),
      )
      // Keep it showing struck in the active list (V1's middle state) until archived.
      markRecentlyCompleted(root, [task])
      return snapshot
    },
    onError: (cause, _generation, context) => {
      cache.rollback(context, 'Completing task', cause)
      forgetRecentlyCompleted(root, [taskKey(task)])
    },
  })

  return {
    isPending: mutation.isPending,
    complete: () => {
      const generation = graph?.generation
      if (generation === undefined || mutation.isPending) {
        return
      }
      mutation.mutate(generation)
    },
  }
}
