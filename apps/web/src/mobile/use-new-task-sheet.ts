import { useCallback, useState, useSyncExternalStore } from 'react'
import { todaysDailyTarget, type OpenTask, type Unlisten } from '@reflect/core'
import { useToday } from '@/lib/use-today.ts'
import { useCoreServices } from '@/services/services-provider.tsx'
import { noop } from '@ocavue/utils'

/**
 * The Daily capture menu's new-task sheet state; see {@link useNewTaskSheet}.
 */
export interface NewTaskSheet {
  /**
   * Show a new empty task for today's daily note and open the sheet on it.
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
}

/**
 * The Daily screen's "New task": the Tasks tab's `+` without leaving the Daily
 * screen. It shows a new empty task for today's daily note (even when the
 * carousel shows another day, like the Tasks tab) and opens the quick-edit
 * sheet on it for the caller to render with the editor focused. The task is
 * written when the sheet closes with text in it; a task left empty is dropped
 * and the note is not touched.
 */
export function useNewTaskSheet(): NewTaskSheet {
  const { tasks: taskService } = useCoreServices()
  const today = useToday()
  const [created, setCreated] = useState<OpenTask | null>(null)
  const [open, setOpen] = useState(false)

  // Follow the task rows only while the sheet is up: a subscription reads
  // every open task in the graph and re-reads on each index change, which the
  // Daily screen otherwise has no use for.
  const subscribe = useCallback(
    (listener: VoidFunction): Unlisten => (open ? taskService.subscribe(listener) : noop),
    [taskService, open],
  )
  const rows = useSyncExternalStore(subscribe, taskService.get, taskService.get).open
  // The sheet edits the task's live row, like the Tasks tab: another change of
  // the note can rewrite the row while the sheet is up. Fall back to the
  // created row when the rows no longer hold the task.
  const task =
    created === null ? null : (rows?.find((row) => row.taskId === created.taskId) ?? created)

  const start = (): void => {
    setCreated(taskService.commands.add(todaysDailyTarget(today)))
    setOpen(true)
  }

  return { start, task, open, setOpen, today }
}
