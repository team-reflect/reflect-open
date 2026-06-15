import { useMutation, useQueryClient } from '@tanstack/react-query'
import { errorMessage, type OpenTask } from '@reflect/core'
import { toggleTask } from '@/lib/note-task'
import { startOperation } from '@/lib/operations'
import { sameTask } from '@/lib/tasks/task-identity'
import { completedTasksQueryKey, tasksQueryKey } from '@/lib/tasks/tasks-query'
import { useGraph } from '@/providers/graph-provider'

/**
 * Complete a task from the Tasks view (Plan 18), optimistically. The row moves
 * to its completed state immediately (so completing feels instant); the reindex
 * then reconciles it. A failed write rolls the row back and surfaces the reason
 * (stale index, or the note is busy) via the operations toast. `complete` is a
 * no-op while a write is in flight or before a graph generation is available.
 *
 * The optimistic edit mirrors the real transition across BOTH task caches: drop
 * the task from the open list and, when the completed ("show archived") list is
 * loaded, add it there as checked — so with archived on the row stays visible,
 * struck through, instead of vanishing until the refetch. When archived is off
 * the completed cache is absent and that half is a no-op.
 *
 * Pulled out of {@link TaskRow} so the cache surgery stays testable apart from
 * rendering, and the row reads as plain markup.
 */
export function useCompleteTask(task: OpenTask): { complete: () => void; isPending: boolean } {
  const { graph } = useGraph()
  const queryClient = useQueryClient()
  const openKey = tasksQueryKey(graph?.root)
  const completedKey = completedTasksQueryKey(graph?.root)

  const mutation = useMutation({
    mutationFn: (generation: number) => toggleTask(task, generation),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: openKey })
      await queryClient.cancelQueries({ queryKey: completedKey })
      const previousOpen = queryClient.getQueryData<OpenTask[]>(openKey)
      const previousCompleted = queryClient.getQueryData<OpenTask[]>(completedKey)
      queryClient.setQueryData<OpenTask[]>(openKey, (rows) =>
        rows?.filter((row) => !sameTask(row, task)),
      )
      // Only when the completed list is loaded (archived on); else a no-op.
      queryClient.setQueryData<OpenTask[]>(completedKey, (rows) =>
        rows ? [{ ...task, checked: true }, ...rows.filter((row) => !sameTask(row, task))] : rows,
      )
      return { previousOpen, previousCompleted }
    },
    onError: (cause, _generation, context) => {
      if (context?.previousOpen !== undefined) {
        queryClient.setQueryData(openKey, context.previousOpen)
      }
      if (context?.previousCompleted !== undefined) {
        queryClient.setQueryData(completedKey, context.previousCompleted)
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
