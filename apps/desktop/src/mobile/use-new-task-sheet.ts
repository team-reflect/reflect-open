import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  errorMessage,
  isSameTask,
  todaysDailyTarget,
  type OpenTask,
  type Unlisten,
} from '@reflect/core'
import { useTaskActions, type TaskActions } from '@/lib/tasks/use-task-actions.ts'
import { useToday } from '@/lib/use-today.ts'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

/**
 * The Daily capture menu's new-task sheet state; see {@link useNewTaskSheet}.
 */
export interface NewTaskSheet {
  /**
   * Add an empty task to today's daily note, then open the sheet on it. A
   * call while an earlier insert is still pending does nothing.
   */
  start: () => void
  /**
   * The task being written: its live row while the sheet is open, else the
   * row as last seen. Kept after close so the sheet's exit animation has content.
   */
  task: OpenTask | null
  open: boolean
  setOpen: (open: boolean) => void
  /**
   * Today's live ISO date: the insert target and the sheet's schedule anchor.
   */
  today: string
  /**
   * The shared task writes the sheet commits, completes, and deletes through.
   */
  actions: TaskActions
}

/**
 * The Daily screen's "New task": the Tasks tab's `+` without leaving the Daily
 * screen. It adds an empty task to today's daily note (even when the carousel
 * shows another day, like the Tasks tab), then opens the quick-edit sheet on
 * it for the caller to render with the editor focused. The sheet's exit rules
 * own the rest: an untyped task is deleted on dismissal, so a change of heart
 * leaves no bare `+ [ ]` in the note. A task that lands after the screen has
 * gone gets no sheet, so it is deleted at once for the same reason.
 */
export function useNewTaskSheet(): NewTaskSheet {
  const { tasks: taskService } = useCoreServices()
  const { operations } = useAppServices()
  const today = useToday()
  const actions = useTaskActions()
  const [created, setCreated] = useState<OpenTask | null>(null)
  const [open, setOpen] = useState(false)
  // Set while an insert is pending: a second tap must not add a second task
  // the sheet never shows. A ref, so a tap in the same tick already sees it.
  const insertingRef = useRef(false)
  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Follow the task rows only while the sheet is up: a subscription reads
  // every open task in the graph and re-reads on each index change, which the
  // Daily screen otherwise has no use for.
  const subscribe = useCallback(
    (listener: VoidFunction): Unlisten => (open ? taskService.subscribe(listener) : () => {}),
    [taskService, open],
  )
  const rows = useSyncExternalStore(subscribe, taskService.get, taskService.get).open
  // The sheet edits the task's live row, like the Tasks tab: a reindex can
  // rewrite the row while the sheet is up, and acting on the stale copy would
  // trip the write-back guard needlessly. Fall back to the created row while
  // the rows don't have it (a read can land before the index catches up) —
  // the guard then refuses any write that no longer applies.
  const task = created === null ? null : (rows?.find((row) => isSameTask(row, created)) ?? created)

  // Straight to the service, not `actions.remove`: that skips while a delete
  // is pending (a repeat-key guard), and after unmount it reads the pending
  // state frozen at the tap, so an earlier sheet's delete would drop this one.
  const removeUnclaimed = async (inserted: OpenTask): Promise<void> => {
    try {
      await taskService.deleteTasks([inserted])
    } catch (cause) {
      operations.start('Deleting tasks').fail(errorMessage(cause))
    }
  }

  const start = async (): Promise<void> => {
    if (insertingRef.current) {
      return
    }
    insertingRef.current = true
    const inserted = await actions.insert(todaysDailyTarget(today))
    insertingRef.current = false
    if (inserted === null) {
      return
    }
    if (!mountedRef.current) {
      void removeUnclaimed(inserted)
      return
    }
    setCreated(inserted)
    setOpen(true)
  }

  return {
    start: () => void start(),
    task,
    open,
    setOpen,
    today,
    actions,
  }
}
