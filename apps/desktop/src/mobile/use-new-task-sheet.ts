import { useState } from 'react'
import type { OpenTask } from '@reflect/core'
import { todaysDailyTarget } from '@/lib/tasks/task-navigation.ts'
import { useTaskActions, type TaskActions } from '@/lib/tasks/use-task-actions.ts'
import { useToday } from '@/lib/use-today.ts'

/** The Daily capture menu's new-task sheet state; see {@link useNewTaskSheet}. */
export interface NewTaskSheet {
  /** Add an empty task to today's daily note, then open the sheet on it. */
  start: () => void
  /** The task being written. Kept after close so the sheet's exit animation has content. */
  task: OpenTask | null
  open: boolean
  setOpen: (open: boolean) => void
  /** Today's live ISO date — the insert target and the sheet's schedule anchor. */
  today: string
  /** The shared task writes the sheet commits, completes, and deletes through. */
  actions: TaskActions
}

/**
 * The Daily screen's "New task" — the Tasks tab's `+` without leaving the
 * Daily screen: add an empty task to today's daily note, then open the
 * quick-edit sheet on it for the caller to render with the editor focused.
 * The sheet's exit rules own the rest; an untyped task is deleted on
 * dismissal, so a change of heart leaves no bare `+ [ ]` in the note.
 */
export function useNewTaskSheet(): NewTaskSheet {
  const today = useToday()
  const actions = useTaskActions()
  const [task, setTask] = useState<OpenTask | null>(null)
  const [open, setOpen] = useState(false)

  const start = async (): Promise<void> => {
    const created = await actions.insert(todaysDailyTarget(today))
    if (created !== null) {
      setTask(created)
      setOpen(true)
    }
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
