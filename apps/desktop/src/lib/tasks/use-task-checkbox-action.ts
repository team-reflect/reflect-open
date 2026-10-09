import { useMutation } from '@tanstack/react-query'
import type { OpenTask } from '@reflect/core'
import { writeTask } from '@/lib/note-task.ts'
import { mutationKeys } from '@/lib/query-client.ts'
import {
  forgetRecentlyCompleted,
  hasRecentlyCompleted,
  markRecentlyCompleted,
} from '@/lib/tasks/recently-completed.ts'
import { asCompleted, asOpen, withoutTasks } from '@/lib/tasks/task-cache.ts'
import { getTaskKey } from '@/lib/tasks/task-identity.ts'
import { type TaskCacheSnapshot, useTaskCacheWriter } from '@/lib/tasks/use-task-cache.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

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
    mutationKey: mutationKeys.tasks.checkboxToggle(graph?.root),
    mutationFn: ({ task, generation }: ToggleTaskInput) =>
      writeTask(task, [{ kind: 'toggle' }], generation),
    onMutate: async ({ task }: ToggleTaskInput): Promise<ToggleTaskContext> => {
      const snapshot = await cache.snapshot()
      const key = getTaskKey(task)
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
        forgetRecentlyCompleted(root, [getTaskKey(task)])
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
