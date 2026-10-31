import { useState } from 'react'
import { errorMessage, type InsertTaskTarget, type OpenTask } from '@reflect/core'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

/**
 * Task actions for the Tasks view's rows and keyboard shortcuts (Plan 18):
 * complete a selection (⌘↵), delete a selection (⌫/⌘⌫), edit one task from the
 * inline editor, and add a task (Return). Each calls a `TaskService` write,
 * which updates the rows optimistically and rolls back or re-reads them on
 * failure; a failure surfaces here once, as a failed operation.
 */
export interface TaskActions {
  complete: (tasks: OpenTask[]) => void
  /**
   * ⌘↵ on a selection (V1's `toggleChecked`): complete the open rows, or — when
   * every selected row is already checked — reopen them all. So a just-completed
   * row (still struck) can be un-done with the same chord.
   */
  toggle: (tasks: OpenTask[]) => void
  remove: (tasks: OpenTask[]) => void
  /**
   * Replace one task's Markdown from the inline editor (Plan 18).
   */
  edit: (task: OpenTask, content: string) => void
  /**
   * Toggle one row checkbox with exact rollback semantics for inline-editor checkbox clicks.
   */
  checkboxToggle: (task: OpenTask) => void
  /**
   * Add a new empty task to the `## Tasks` section of `target`'s note
   * (Return-to-add, V1) and return the
   * optimistic row to select — its inline editor opens focused. Resolves to
   * `null` when there's no graph or the write failed (the toast already fired).
   */
  insert: (target: InsertTaskTarget) => Promise<OpenTask | null>
  /**
   * Enter on a row (V1 continuous entry): persist the row's edit (when `content`
   * isn't null) and add the next task after it, in its own list, in one write.
   * Returns the new row to select, or null when the write failed (the toast
   * already fired) and the draft was persisted on its own instead.
   */
  insertAfter: (task: OpenTask, content: string | null) => Promise<OpenTask | null>
  /**
   * Save an inline edit and toggle the task checkbox in one write; `null` content toggles only.
   */
  editAndToggle: (task: OpenTask, content: string | null) => void
  /**
   * Schedule a selection (⌘⇧S / the calendar, V1): set each task's due date to
   * `isoDate`, or clear it when `isoDate` is null. Written as a content edit that
   * adds/replaces the `[[YYYY-MM-DD]]` link the projection reads as the due date.
   */
  schedule: (tasks: OpenTask[], isoDate: string | null) => void
  /**
   * Convert a selection to plain bullets (⌘⇧K, V1's "Convert to checklist"
   * restated for markdown): drop each task's checkbox so it leaves the Tasks
   * view but stays in its note as an ordinary list item.
   */
  convertToBullet: (tasks: OpenTask[]) => void
  /**
   * Convert the inline-edited task to a bullet, saving its edit in the same
   * write (⌘⇧K while editing), so the unsaved draft is never lost to the convert.
   */
  editAndConvertToBullet: (task: OpenTask, content: string) => void
  /**
   * Archive (⌘⇧↵): stop showing the session's completed tasks in the active list.
   */
  archive: () => void
  isPending: boolean
}

type TaskWriteKind =
  | 'complete'
  | 'reopen'
  | 'delete'
  | 'edit'
  | 'schedule'
  | 'convert'
  | 'editAndConvert'
  | 'insert'
  | 'editAndToggle'

type PendingWrites = Readonly<Partial<Record<TaskWriteKind, number>>>

export function useTaskActions(): TaskActions {
  const { graph } = useGraph()
  const root = graph?.root ?? null
  const { tasks: taskService } = useCoreServices()
  const { operations } = useAppServices()
  const [pending, setPending] = useState<PendingWrites>({})

  const isPending = (kind: TaskWriteKind): boolean => (pending[kind] ?? 0) > 0

  const count = (kind: TaskWriteKind, step: 1 | -1): void => {
    setPending((current) => ({ ...current, [kind]: (current[kind] ?? 0) + step }))
  }

  /**
   * Run one write, tracked as pending under `kind`; a failure surfaces as a
   * failed `label` operation and resolves to `null`.
   */
  async function run<T>(
    kind: TaskWriteKind,
    label: string,
    write: () => Promise<T>,
  ): Promise<T | null> {
    count(kind, 1)
    let result: T | null = null
    let failure: { cause: unknown } | null = null
    try {
      result = await write()
    } catch (cause) {
      failure = { cause }
    }
    // No `finally`: the React Compiler skips any function that has one. The
    // count drops before the failure is reported, so a throwing listener can't
    // leave it stuck.
    count(kind, -1)
    if (failure !== null) {
      operations.start(label).fail(errorMessage(failure.cause))
    }
    return result
  }

  const complete = (tasks: OpenTask[]): void => {
    void run('complete', 'Completing tasks', () => taskService.completeTasks(tasks))
  }

  async function persistTaskDraft(task: OpenTask, content: string | null): Promise<void> {
    if (content === '') {
      await run('delete', 'Deleting tasks', () => taskService.deleteTasks([task]))
    } else if (content !== null) {
      await run('edit', 'Editing task', () => taskService.editTask(task, content))
    }
  }

  return {
    isPending: Object.values(pending).some((value) => value > 0),
    complete: (tasks) => {
      // ⌘↵ *completes*; with archived rows in the selection, toggling an
      // already-checked task would reopen it on disk. Only act on open rows.
      const open = tasks.filter((task) => !task.checked)
      if (open.length > 0 && !isPending('complete')) {
        complete(open)
      }
    },
    toggle: (tasks) => {
      if (tasks.length === 0) {
        return
      }
      // V1: all checked → reopen them all; otherwise complete the open ones.
      if (tasks.every((task) => task.checked)) {
        if (!isPending('reopen')) {
          void run('reopen', 'Reopening tasks', () => taskService.reopenTasks(tasks))
        }
      } else {
        const open = tasks.filter((task) => !task.checked)
        if (open.length > 0 && !isPending('complete')) {
          complete(open)
        }
      }
    },
    remove: (tasks) => {
      if (tasks.length > 0 && !isPending('delete')) {
        void run('delete', 'Deleting tasks', () => taskService.deleteTasks(tasks))
      }
    },
    edit: (task, content) => {
      void run('edit', 'Editing task', () => taskService.editTask(task, content))
    },
    checkboxToggle: (task) => {
      void run('editAndToggle', task.checked ? 'Reopening task' : 'Completing task', () => {
        return taskService.editAndToggleTask(task, null)
      })
    },
    insert: (target) => run('insert', 'Adding task', () => taskService.addTask(target)),
    insertAfter: async (task, content) => {
      const created = await run('insert', 'Adding task', () => {
        return taskService.addTaskAfter(task, content)
      })
      if (created !== null) {
        return created
      }
      // The failure is surfaced and rolled back; still keep the draft.
      await persistTaskDraft(task, content)
      return null
    },
    editAndToggle: (task, content) => {
      void run('editAndToggle', task.checked ? 'Reopening task' : 'Completing task', () => {
        return taskService.editAndToggleTask(task, content)
      })
    },
    schedule: (tasks, isoDate) => {
      if (tasks.length > 0 && !isPending('schedule')) {
        void run('schedule', 'Scheduling tasks', () => taskService.scheduleTasks(tasks, isoDate))
      }
    },
    convertToBullet: (tasks) => {
      if (tasks.length > 0 && !isPending('convert')) {
        void run('convert', 'Converting tasks', () => taskService.convertTasks(tasks))
      }
    },
    editAndConvertToBullet: (task, content) => {
      if (!isPending('editAndConvert')) {
        void run('editAndConvert', 'Converting task', () => {
          return taskService.editAndConvertTask(task, content)
        })
      }
    },
    archive: () => taskService.archiveRecentlyCompleted(root),
  }
}
