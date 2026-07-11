import { useMutation } from '@tanstack/react-query'
import { type OpenTask } from '@reflect/core'
import { continueTaskInContext, type ContinuedTaskInContext } from '@/lib/note-task'
import { relocateRecentlyCompleted } from '@/lib/tasks/recently-completed'
import { withEditedTask, withoutTasks } from '@/lib/tasks/task-cache'
import { insertedTaskRow } from '@/lib/tasks/task-insert-target'
import { insertTargetForTask } from '@/lib/tasks/task-navigation'
import { useTaskCacheWriter } from '@/lib/tasks/use-task-cache'
import { useGraph } from '@/providers/graph-provider'

interface ContextInsertInput {
  readonly task: OpenTask
  readonly content: string | null
  readonly generation: number
}

export interface TaskContextInsert {
  /**
   * Resolve the current draft, add an empty row in the same context, and return it.
   * A failed write rejects after its optimistic cache update has been rolled back.
   */
  readonly insert: (task: OpenTask, content: string | null) => Promise<OpenTask | null>
  /** Whether a contextual insert already has a disk write in flight. */
  readonly isPending: boolean
}

/**
 * Context-preserving continuous entry for grouped Tasks rows. The disk transform
 * and optimistic cache update stay atomic from the caller's perspective, including
 * replacing a cleared row and displacing a stale offset collision until reindexing.
 */
export function useTaskContextInsert(): TaskContextInsert {
  const { graph } = useGraph()
  const cache = useTaskCacheWriter()
  const mutation = useMutation({
    mutationFn: ({ task, content, generation }: ContextInsertInput) =>
      continueTaskInContext(task, content, generation),
    onMutate: async ({ task, content }: ContextInsertInput) => {
      const snapshot = await cache.snapshot()
      const patch = (rows: OpenTask[] | undefined): OpenTask[] | undefined => {
        if (content === '') {
          return withoutTasks(rows, [task])
        }
        return content === null ? rows : withEditedTask(rows, task, content)
      }
      cache.patch(patch, patch)
      return snapshot
    },
    onError: (cause, _variables, context) => cache.rollback(context, 'Adding task', cause),
  })

  return {
    isPending: mutation.isPending,
    insert: async (task, content) => {
      if (graph === null || mutation.isPending) {
        return null
      }
      const { generation, root } = graph
      const result: ContinuedTaskInContext = await mutation.mutateAsync({
        task,
        content,
        generation,
      })
      cache.relocate(task.notePath, result.offsetChanges)
      relocateRecentlyCompleted(root, task.notePath, result.offsetChanges)
      const created = insertedTaskRow(
        insertTargetForTask(task),
        result.created.markerOffset,
        task.breadcrumbs,
        result.created.raw,
      )
      cache.addOpen(created)
      return created
    },
  }
}
