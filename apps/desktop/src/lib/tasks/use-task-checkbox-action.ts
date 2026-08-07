import { useMutation } from '@tanstack/react-query'
import type { OpenTask } from '@reflect/core'
import { toggleTask } from '@/lib/note-task'
import {
  forgetRecentlyCompleted,
  hasRecentlyCompleted,
  markRecentlyCompleted,
} from '@/lib/tasks/recently-completed'
import { asCompleted, asOpen, withoutTasks } from '@/lib/tasks/task-cache'
import { taskKey } from '@/lib/tasks/task-identity'
import { type TaskCacheSnapshot, useTaskCacheWriter } from '@/lib/tasks/use-task-cache'
import { useGraph } from '@/providers/graph-provider'

interface ToggleTaskContext {
  snapshot: TaskCacheSnapshot
  wasRecentlyCompleted: boolean
}

interface ToggleTaskInput {
  task: OpenTask
  generation: number
}

export interface TaskCheckboxAction {
  /** Toggle one task's checked marker through the row-level optimistic cache path. */
  toggle: (task: OpenTask) => void
  /** Whether this action already has a disk write in flight. */
  isPending: boolean
}

/**
 * Shared single-row checkbox toggle for task rows and the inline editor.
 * Unlike bulk selection toggles, this rolls back the exact optimistic row and
 * restores the session struck set on failure.
 */
export function useTaskCheckboxAction(): TaskCheckboxAction {
  const { graph } = useGraph()
  const cache = useTaskCacheWriter()
  const root = graph?.root ?? null

  const mutation = useMutation({
    mutationFn: ({ task, generation }: ToggleTaskInput) => toggleTask(task, generation),
    onMutate: async ({ task }: ToggleTaskInput): Promise<ToggleTaskContext> => {
      const snapshot = await cache.snapshot()
      const key = taskKey(task)
      const wasRecentlyCompleted = hasRecentlyCompleted(root, key)
      if (task.checked) {
        cache.patch(
          (rows) => asOpen(rows, [task]),
          (rows) => withoutTasks(rows, [task]),
        )
        forgetRecentlyCompleted(root, [key])
      } else {
        cache.patch(
          (rows) => withoutTasks(rows, [task]),
          (rows) => asCompleted(rows, [task]),
        )
        markRecentlyCompleted(root, [task])
      }
      return { snapshot, wasRecentlyCompleted }
    },
    onError: (cause, { task }, context) => {
      cache.rollback(context?.snapshot, task.checked ? 'Reopening task' : 'Completing task', cause)
      if (task.checked && context?.wasRecentlyCompleted) {
        markRecentlyCompleted(root, [task])
      } else if (!task.checked) {
        forgetRecentlyCompleted(root, [taskKey(task)])
      }
    },
  })

  return {
    isPending: mutation.isPending,
    toggle: (task) => {
      const generation = graph?.generation
      if (generation === undefined || mutation.isPending) {
        return
      }
      mutation.mutate({ task, generation })
    },
  }
}
