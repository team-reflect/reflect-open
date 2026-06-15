import { useMutation, useQueryClient } from '@tanstack/react-query'
import { errorMessage, type OpenTask } from '@reflect/core'
import { toggleTask } from '@/lib/note-task'
import { startOperation } from '@/lib/operations'
import { sameTask } from '@/lib/tasks/task-identity'
import { tasksQueryKey } from '@/lib/tasks/tasks-query'
import { useGraph } from '@/providers/graph-provider'

/**
 * Complete a task from the Tasks view (Plan 18), optimistically. The row drops
 * from the list immediately (so completing feels instant); the reindex then
 * reconciles it. A failed write rolls the row back and surfaces the reason (stale
 * index, or the note is busy) via the operations toast. `complete` is a no-op
 * while a write is in flight or before a graph generation is available.
 *
 * Pulled out of {@link TaskRow} so the cache surgery stays testable apart from
 * rendering, and the row reads as plain markup.
 */
export function useCompleteTask(task: OpenTask): { complete: () => void; isPending: boolean } {
  const { graph } = useGraph()
  const queryClient = useQueryClient()
  const key = tasksQueryKey(graph?.root)

  const mutation = useMutation({
    mutationFn: (generation: number) => toggleTask(task, generation),
    onMutate: async () => {
      // Drop the row now so completing feels instant; the reindex reconciles.
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<OpenTask[]>(key)
      queryClient.setQueryData<OpenTask[]>(key, (rows) => rows?.filter((row) => !sameTask(row, task)))
      return { previous }
    },
    onError: (cause, _generation, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(key, context.previous)
      }
      startOperation('Completing task').fail(errorMessage(cause))
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
