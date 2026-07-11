import { useCallback } from 'react'
import { type OpenTask } from '@reflect/core'
import { type TaskNavigate } from '@/components/tasks/task-editor'
import {
  insertTargetForBucket,
  insertTargetForTask,
  previousTaskKey,
} from '@/lib/tasks/task-navigation'
import { taskKey } from '@/lib/tasks/task-identity'
import { type TaskActions } from '@/lib/tasks/use-task-actions'
import { type TaskSelection } from '@/lib/tasks/use-task-selection'

/** The inline-editor callbacks one task row binds (Plan 18). */
export interface TaskRowEditHandlers {
  onEditCommit: (content: string) => void
  onEditContinue: (content: string | null) => void
  onEditDelete: () => void
  onEditDeleteEmpty: () => void
  onEditCancel: () => void
  onEditComplete: (content: string | null) => void
  onEditCheckboxToggle: (content: string | null) => void
  onEditConvertToBullet: (content: string | null) => void
  onEditFlush: (content: string) => void
  onEditNavigate: TaskNavigate
}

export interface TaskRowHandlerDeps {
  selection: TaskSelection
  actions: TaskActions
  /** The flat, render-order tasks — used to pick the row to select after a delete. */
  orderedTasks: readonly OpenTask[]
  /** Today's ISO date — Enter adds the next task into the row's group (V1). */
  today: string
  /** Bring a row into view after a keyboard move (V1 scrolls the selection). */
  scrollToKey: (key: string | null) => void
}

/**
 * The inline editor's per-row callbacks (Plan 18, V1 parity), built once with the
 * selection/actions/order in scope so every row shares the exact same wiring.
 * This is where V1's keyboard flow lives: Enter commits and opens the next task
 * (continuous entry), ↑/↓ move between rows mid-edit (the unmount flush saves the
 * one you leave), and Backspace on an empty row deletes it and lands you on the
 * previous one — so adding and triaging tasks never leaves the keyboard.
 */
export function useTaskRowHandlers({
  selection,
  actions,
  orderedTasks,
  today,
  scrollToKey,
}: TaskRowHandlerDeps): (task: OpenTask) => TaskRowEditHandlers {
  const selectExclusively = useCallback(
    (key: string) => {
      selection.clickSelect(key, { metaKey: false, ctrlKey: false, shiftKey: false })
      scrollToKey(key)
    },
    [selection, scrollToKey],
  )

  return useCallback(
    (task: OpenTask): TaskRowEditHandlers => ({
      onEditCommit: (content) => {
        actions.edit(task, content)
        selection.clear()
      },
      onEditContinue: (content) => {
        // Enter: persist this row, add the next task into its breadcrumb context
        // when it has one (otherwise use V1's Current/note bucket target), and
        // select the new row so its editor opens.
        const target =
          task.breadcrumbs.length > 0
            ? insertTargetForTask(task)
            : insertTargetForBucket(task, today)
        if (target === null) {
          // An ungrouped Overdue/Upcoming bucket spans many notes, so V1 can't add
          // there. Persist the edit (or delete an emptied row) and exit cleanly.
          if (content === '') {
            actions.remove([task])
          } else if (content !== null) {
            actions.edit(task, content)
          }
          selection.clear()
          return
        }
        void actions.insertAfter(task, content, target).then((created) => {
          if (created !== null) {
            selectExclusively(taskKey(created))
          } else {
            selection.clear()
          }
        })
      },
      onEditDelete: () => {
        actions.remove([task])
        selection.clear()
      },
      onEditDeleteEmpty: () => {
        // Backspace on an empty row: delete it and land on the previous one (V1),
        // so a stream of empty rows can be trimmed without reaching for the mouse.
        const previous = previousTaskKey(orderedTasks, task)
        actions.remove([task])
        if (previous !== null) {
          selectExclusively(previous)
        } else {
          selection.clear()
        }
      },
      // The finalizer deletes an empty row on exit from the live content; cancel
      // itself only ends edit mode.
      onEditCancel: () => selection.clear(),
      onEditComplete: (content) => {
        if (task.checked) {
          // Already complete (editing an archived row) — ⌘↵ saves an edit but
          // never flips the marker back to open.
          if (content !== null) {
            actions.edit(task, content)
          }
        } else if (content === null) {
          actions.complete([task])
        } else {
          actions.editAndToggle(task, content)
        }
        selection.clear()
      },
      onEditCheckboxToggle: (content) => {
        if (content === null) {
          actions.checkboxToggle(task)
        } else {
          actions.editAndToggle(task, content)
        }
        selection.clear()
      },
      onEditConvertToBullet: (content) => {
        // ⌘⇧K while editing (or the toolbar button on the sole row): convert to a
        // bullet, saving the edit first when it changed (V1 muscle memory). An
        // emptied row took the delete path in the finalizer, so `content` is the
        // new text or null (unchanged) here.
        if (content === null) {
          actions.convertToBullet([task])
        } else {
          actions.editAndConvertToBullet(task, content)
        }
        selection.clear()
      },
      // Unmount flush: the selection already moved, so persist the edit but leave
      // the (new) selection alone.
      onEditFlush: (content) => actions.edit(task, content),
      onEditNavigate: (direction, { span }) => {
        if (span) {
          selection.extend(direction)
        } else {
          selection.move(direction)
        }
        scrollToKey(selection.activeKey())
      },
    }),
    [actions, selection, orderedTasks, today, selectExclusively, scrollToKey],
  )
}
