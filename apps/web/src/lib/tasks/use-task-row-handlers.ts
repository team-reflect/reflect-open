import { useCallback } from 'react'
import { previousTaskKey, type OpenTask } from '@reflect/core'
import type { TaskEditorHandlers } from '@/components/tasks/task-editor.tsx'
import type { TaskSelection } from '@/lib/tasks/use-task-selection.ts'
import { useCoreServices } from '@/services/services-provider.tsx'

export interface TaskRowHandlerDeps {
  selection: TaskSelection
  /**
   * The flat, render-order tasks, used to pick the row to select after a delete.
   */
  orderedTasks: readonly OpenTask[]
  /**
   * Bring a row into view after a keyboard move (V1 scrolls the selection).
   */
  scrollToKey: (key: string | null) => void
}

/**
 * The inline editor's per-row handlers (Plan 18, V1 parity), built once with
 * the selection and the row order in scope so every row shares the same
 * wiring. Each handler sends one task command and moves the selection: Enter
 * opens the next task, ↑/↓ move between rows mid-edit, and Backspace on an
 * empty row deletes it and lands on the previous one.
 */
export function useTaskRowHandlers({
  selection,
  orderedTasks,
  scrollToKey,
}: TaskRowHandlerDeps): (task: OpenTask) => TaskEditorHandlers {
  const { commands } = useCoreServices().tasks
  const selectExclusively = useCallback(
    (key: string) => {
      selection.clickSelect(key, { metaKey: false, ctrlKey: false, shiftKey: false })
      scrollToKey(key)
    },
    [selection, scrollToKey],
  )

  return useCallback(
    (task: OpenTask): TaskEditorHandlers => ({
      onContinue: () => {
        selectExclusively(commands.continueAfter(task).taskId)
      },
      onCancel: () => {
        selection.clear()
      },
      onComplete: () => {
        void commands.complete([task])
        selection.clear()
      },
      onConvertToBullet: () => {
        void commands.convert([task])
        selection.clear()
      },
      onDelete: () => {
        void commands.remove([task])
        selection.clear()
      },
      onDeleteEmpty: () => {
        const previous = previousTaskKey(orderedTasks, task)
        void commands.remove([task])
        if (previous !== null) {
          selectExclusively(previous)
        } else {
          selection.clear()
        }
      },
      onNavigate: (direction, { span }) => {
        if (span) {
          selection.extend(direction)
        } else {
          selection.move(direction)
        }
        scrollToKey(selection.activeKey())
      },
    }),
    [commands, selection, orderedTasks, selectExclusively, scrollToKey],
  )
}
