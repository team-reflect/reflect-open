import { useMutation } from '@tanstack/react-query'
import type { OpenTask, TaskEditResult } from '@reflect/core'
import { insertTask, writeTask } from '@/lib/note-task.ts'
import { mutationKeys } from '@/lib/query-client.ts'
import {
  archiveRecentlyCompleted,
  forgetRecentlyCompleted,
  hasRecentlyCompleted,
  markRecentlyCompleted,
  relocateRecentlyCompleted,
} from '@/lib/tasks/recently-completed.ts'
import { getScheduledMarkdown } from '@/lib/tasks/task-schedule-content.ts'
import {
  asCompleted,
  asOpen,
  withEditedTask,
  withoutTasks,
  withRelocatedTasks,
  type TaskMoves,
} from '@/lib/tasks/task-cache.ts'
import { getTaskKey } from '@/lib/tasks/task-identity.ts'
import { createInsertedTaskRow, type InsertTaskTarget } from '@/lib/tasks/task-insert-target.ts'
import { useTaskCheckboxAction } from '@/lib/tasks/use-task-checkbox-action.ts'
import { useTaskCacheWriter } from '@/lib/tasks/use-task-cache.ts'
import { useTaskContextInsert } from '@/lib/tasks/use-task-context-insert.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

/**
 * Bulk task actions for the Tasks view's keyboard shortcuts (Plan 18): complete
 * a selection (⌘↵), delete a selection (⌫/⌘⌫), edit one task from the inline
 * editor, and add a task (Return). They update the open and completed caches
 * optimistically through the shared {@link useTaskCacheWriter} — the same path
 * single-row checkbox toggle takes — so the selection reacts instantly,
 * then the reindex reconciles. A failed write rolls every row back and surfaces
 * the reason once.
 *
 * Writes within a batch run **sequentially**: tasks can share a note, and two
 * concurrent edits to one file would race (the loser's read predates the
 * winner's write). Each write reports where the note's tasks moved, and the
 * rest of the batch is re-addressed from that before its own write.
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
  /** Replace one task's Markdown from the inline editor (Plan 18). */
  edit: (task: OpenTask, content: string) => void
  /** Toggle one row checkbox with exact rollback semantics for inline-editor checkbox clicks. */
  checkboxToggle: (task: OpenTask) => void
  /**
   * Add a new empty task to the `## Tasks` section of `target`'s note
   * (Return-to-add, V1) and return the
   * optimistic row to select — its inline editor opens focused. Resolves to
   * `null` when there's no graph or the write failed (the toast already fired).
   */
  insert: (target: InsertTaskTarget) => Promise<OpenTask | null>
  /**
   * Enter while editing (V1 continuous entry): persist the current row's edit
   * (when `content` isn't null), then add the next task in `target` and return it
   * to select. A task with breadcrumb context is continued structurally inside
   * that context; other tasks retain the V1 bucket-target behavior.
   */
  insertAfter: (
    task: OpenTask,
    content: string | null,
    target: InsertTaskTarget,
  ) => Promise<OpenTask | null>
  /** Save an inline edit and toggle the task checkbox in one write. */
  editAndToggle: (task: OpenTask, content: string) => void
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
  /** Archive (⌘⇧↵): stop showing the session's completed tasks in the active list. */
  archive: () => void
  isPending: boolean
}

export function useTaskActions(): TaskActions {
  const { graph } = useGraph()
  const root = graph?.root ?? null
  const cache = useTaskCacheWriter()
  const checkboxAction = useTaskCheckboxAction()
  const contextInsert = useTaskContextInsert()

  /** Re-key the cached rows and the session's struck set from a write's `moved` map. */
  const relocate = (notePath: string, moved: TaskMoves): void => {
    cache.relocate(notePath, moved)
    relocateRecentlyCompleted(root, notePath, moved)
  }

  /**
   * Write `tasks` one at a time. Tasks can share a note, and a removal moves
   * the items below it, so after each write the rest of the batch is
   * re-addressed from the write's `moved` map before its own write.
   */
  async function writeEach(
    tasks: readonly OpenTask[],
    write: (task: OpenTask) => Promise<TaskEditResult>,
  ): Promise<void> {
    let pending: readonly OpenTask[] = tasks
    for (let task = pending[0]; task !== undefined; task = pending[0]) {
      const result = await write(task)
      relocate(task.notePath, result.moved)
      const rest: readonly OpenTask[] = pending.slice(1)
      pending = withRelocatedTasks(rest, task.notePath, result.moved)
    }
  }

  const completeMutation = useMutation({
    mutationKey: mutationKeys.tasks.complete(graph?.root),
    mutationFn: async (tasks: OpenTask[]) => {
      const generation = graph?.generation
      if (generation === undefined) {
        throw new Error('No graph is open.')
      }
      await writeEach(tasks, (task) => writeTask(task, [{ kind: 'toggle' }], generation))
    },
    onMutate: async (tasks: OpenTask[]) => {
      const snapshot = await cache.snapshot()
      // Drop the completed rows from the open list, and (when archived is on)
      // prepend them as checked to the completed list so they stay visible struck.
      cache.patch(
        (rows) => withoutTasks(rows, tasks),
        (rows) => asCompleted(rows, tasks),
      )
      // Keep them showing struck (V1's middle state) until archived.
      markRecentlyCompleted(root, tasks)
      return snapshot
    },
    onError: (cause, tasks) => {
      // A batch can fail after earlier writes landed — refetch truth rather than
      // restore a snapshot that would un-do the ones that persisted.
      cache.reconcile('Completing tasks', cause)
      forgetRecentlyCompleted(root, tasks.map(getTaskKey))
    },
  })

  const reopenMutation = useMutation({
    mutationKey: mutationKeys.tasks.reopen(graph?.root),
    mutationFn: async (tasks: OpenTask[]) => {
      const generation = graph?.generation
      if (generation === undefined) {
        throw new Error('No graph is open.')
      }
      await writeEach(tasks, (task) => writeTask(task, [{ kind: 'toggle' }], generation)) // [x] → [ ]
    },
    onMutate: async (tasks: OpenTask[]) => {
      const snapshot = await cache.snapshot()
      // Put them back in the open list (unchecked), drop them from the completed
      // list and this session's struck set — the inverse of completing.
      cache.patch(
        (rows) => asOpen(rows, tasks),
        (rows) => withoutTasks(rows, tasks),
      )
      forgetRecentlyCompleted(root, tasks.map(getTaskKey))
      return snapshot
    },
    onError: (cause) => cache.reconcile('Reopening tasks', cause),
  })

  const deleteMutation = useMutation({
    mutationKey: mutationKeys.tasks.delete(graph?.root),
    mutationFn: async (tasks: OpenTask[]) => {
      const generation = graph?.generation
      if (generation === undefined) {
        throw new Error('No graph is open.')
      }
      await writeEach(tasks, (task) => writeTask(task, [{ kind: 'remove' }], generation))
    },
    onMutate: async (tasks: OpenTask[]) => {
      const snapshot = await cache.snapshot()
      // A delete removes the task from both lists outright.
      cache.patch(
        (rows) => withoutTasks(rows, tasks),
        (rows) => withoutTasks(rows, tasks),
      )
      // A deleted task must not linger struck in the session's completed set.
      forgetRecentlyCompleted(root, tasks.map(getTaskKey))
      return snapshot
    },
    onError: (cause, tasks) => {
      cache.reconcile('Deleting tasks', cause)
      // The delete dropped checked rows from the session's struck set; if it
      // failed they're still `[x]` on disk, so restore them or they'd vanish from
      // the default list (gone from open, struck-set, and the unloaded archived query).
      markRecentlyCompleted(
        root,
        tasks.filter((task) => task.checked),
      )
    },
  })

  const editMutation = useMutation({
    mutationKey: mutationKeys.tasks.edit(graph?.root),
    mutationFn: ({ task, content }: { task: OpenTask; content: string }) => {
      const generation = graph?.generation
      if (generation === undefined) {
        throw new Error('No graph is open.')
      }
      return writeTask(task, [{ kind: 'setMarkdown', markdown: content }], generation)
    },
    onMutate: async ({ task, content }: { task: OpenTask; content: string }) => {
      const snapshot = await cache.snapshot()
      // Show the new text in both lists before the reindex; the row keeps its
      // place until the index re-derives any due date (see withEditedTask).
      cache.patch(
        (rows) => withEditedTask(rows, task, content),
        (rows) => withEditedTask(rows, task, content),
      )
      return snapshot
    },
    onError: (cause, _vars, context) => cache.rollback(context, 'Editing task', cause),
  })

  const scheduleMutation = useMutation({
    mutationKey: mutationKeys.tasks.schedule(graph?.root),
    mutationFn: async ({ tasks, isoDate }: { tasks: OpenTask[]; isoDate: string | null }) => {
      const generation = graph?.generation
      if (generation === undefined) {
        throw new Error('No graph is open.')
      }
      await writeEach(tasks, (task) =>
        writeTask(
          task,
          [{ kind: 'setMarkdown', markdown: getScheduledMarkdown(task, isoDate) }],
          generation,
        ),
      )
    },
    onMutate: async ({ tasks, isoDate }: { tasks: OpenTask[]; isoDate: string | null }) => {
      const snapshot = await cache.snapshot()
      // Show the new date link in place; the row only changes bucket once the
      // reindex re-derives the due date (V1 likewise defers the move).
      const patch = (rows: OpenTask[] | undefined): OpenTask[] | undefined =>
        tasks.reduce<OpenTask[] | undefined>(
          (acc, task) => withEditedTask(acc, task, getScheduledMarkdown(task, isoDate)),
          rows,
        )
      cache.patch(patch, patch)
      return snapshot
    },
    onError: (cause) => cache.reconcile('Scheduling tasks', cause),
  })

  const convertMutation = useMutation({
    mutationKey: mutationKeys.tasks.convert(graph?.root),
    mutationFn: async (tasks: OpenTask[]) => {
      const generation = graph?.generation
      if (generation === undefined) {
        throw new Error('No graph is open.')
      }
      await writeEach(tasks, (task) => writeTask(task, [{ kind: 'toBullet' }], generation))
    },
    onMutate: async (tasks: OpenTask[]) => {
      const snapshot = await cache.snapshot()
      // A converted task is no longer a checkbox, so it leaves both lists outright
      // — same optimistic shape as a delete.
      cache.patch(
        (rows) => withoutTasks(rows, tasks),
        (rows) => withoutTasks(rows, tasks),
      )
      // A converted task must not linger struck in the session's completed set.
      forgetRecentlyCompleted(root, tasks.map(getTaskKey))
      return snapshot
    },
    onError: (cause, tasks) => {
      cache.reconcile('Converting tasks', cause)
      // The convert dropped checked rows from the session's struck set; if it
      // failed they're still `[x]` on disk, so restore them or they'd vanish from
      // the default list (gone from open, struck-set, and the unloaded archived query).
      markRecentlyCompleted(
        root,
        tasks.filter((task) => task.checked),
      )
    },
  })

  const editAndConvertMutation = useMutation({
    mutationKey: mutationKeys.tasks.editAndConvert(graph?.root),
    mutationFn: async ({ task, content }: { task: OpenTask; content: string }) => {
      const generation = graph?.generation
      if (generation === undefined) {
        throw new Error('No graph is open.')
      }
      const result = await writeTask(
        task,
        [{ kind: 'setMarkdown', markdown: content }, { kind: 'toBullet' }],
        generation,
      )
      relocate(task.notePath, result.moved)
    },
    onMutate: async ({ task }: { task: OpenTask; content: string }) => {
      const snapshot = await cache.snapshot()
      // The row leaves the view (it's no longer a checkbox) — same optimistic shape
      // as a plain convert.
      cache.patch(
        (rows) => withoutTasks(rows, [task]),
        (rows) => withoutTasks(rows, [task]),
      )
      forgetRecentlyCompleted(root, [getTaskKey(task)])
      return snapshot
    },
    onError: (cause, { task }, context) => {
      cache.rollback(context, 'Converting task', cause)
      if (task.checked) {
        markRecentlyCompleted(root, [task])
      }
    },
  })

  const insertMutation = useMutation({
    mutationKey: mutationKeys.tasks.insert(graph?.root),
    mutationFn: (target: InsertTaskTarget) => {
      const generation = graph?.generation
      if (generation === undefined) {
        throw new Error('No graph is open.')
      }
      return insertTask(target.notePath, generation)
    },
    onError: (cause) => cache.reconcile('Adding task', cause),
  })

  const editAndToggleMutation = useMutation({
    mutationKey: mutationKeys.tasks.editAndToggle(graph?.root),
    mutationFn: async ({ task, content }: { task: OpenTask; content: string }) => {
      const generation = graph?.generation
      if (generation === undefined) {
        throw new Error('No graph is open.')
      }
      await writeTask(
        task,
        [{ kind: 'setMarkdown', markdown: content }, { kind: 'toggle' }],
        generation,
      )
    },
    onMutate: async ({ task, content }: { task: OpenTask; content: string }) => {
      const snapshot = await cache.snapshot()
      const edited = withEditedTask([task], task, content)?.[0] ?? task
      const wasRecentlyCompleted = hasRecentlyCompleted(root, getTaskKey(task))
      if (task.checked) {
        cache.patch(
          (rows) => asOpen(rows, [edited]),
          (rows) => withoutTasks(rows, [task]),
        )
        forgetRecentlyCompleted(root, [getTaskKey(task)])
      } else {
        // Surface the *edited* row struck (its new text), in both the completed
        // cache (archived on) and the session set (off) — not the pre-edit task.
        cache.patch(
          (rows) => withoutTasks(rows, [task]),
          (rows) => asCompleted(rows, [edited]),
        )
        markRecentlyCompleted(root, [edited])
      }
      return { snapshot, wasRecentlyCompleted }
    },
    onError: (cause, { task }, context) => {
      // One write: nothing landed, so the pre-write lists are the truth.
      cache.rollback(context?.snapshot, task.checked ? 'Reopening task' : 'Completing task', cause)
      if (task.checked && context?.wasRecentlyCompleted) {
        markRecentlyCompleted(root, [task])
      } else if (!task.checked) {
        forgetRecentlyCompleted(root, [getTaskKey(task)])
      }
    },
  })

  /**
   * Write a new empty task into `target`'s note and surface it as the optimistic
   * row to select, or null when the write failed (reconcile already surfaced it).
   * The Tasks section can sit above other tasks of the note, so their cached
   * rows are re-keyed from the write's `moved` map before the new row is added.
   */
  async function insertInto(target: InsertTaskTarget): Promise<OpenTask | null> {
    try {
      const result = await insertMutation.mutateAsync(target)
      relocate(target.notePath, result.moved)
      const created = createInsertedTaskRow(target, result.created)
      cache.addOpen(created)
      return created
    } catch {
      return null
    }
  }

  async function persistTaskDraft(task: OpenTask, content: string | null): Promise<boolean> {
    try {
      if (content === '') {
        await deleteMutation.mutateAsync([task])
      } else if (content !== null) {
        await editMutation.mutateAsync({ task, content })
      }
      return true
    } catch {
      return false
    }
  }
  return {
    isPending:
      completeMutation.isPending ||
      reopenMutation.isPending ||
      deleteMutation.isPending ||
      editMutation.isPending ||
      editAndToggleMutation.isPending ||
      checkboxAction.isPending ||
      insertMutation.isPending ||
      contextInsert.isPending ||
      scheduleMutation.isPending ||
      convertMutation.isPending ||
      editAndConvertMutation.isPending,
    complete: (tasks) => {
      // ⌘↵ *completes*; with archived rows in the selection, toggling an
      // already-checked task would reopen it on disk. Only act on open rows.
      const open = tasks.filter((task) => !task.checked)
      if (open.length > 0 && graph?.generation !== undefined && !completeMutation.isPending) {
        completeMutation.mutate(open)
      }
    },
    toggle: (tasks) => {
      if (tasks.length === 0 || graph?.generation === undefined) {
        return
      }
      // V1: all checked → reopen them all; otherwise complete the open ones.
      if (tasks.every((task) => task.checked)) {
        if (!reopenMutation.isPending) {
          reopenMutation.mutate(tasks)
        }
      } else {
        const open = tasks.filter((task) => !task.checked)
        if (open.length > 0 && !completeMutation.isPending) {
          completeMutation.mutate(open)
        }
      }
    },
    remove: (tasks) => {
      if (tasks.length > 0 && graph?.generation !== undefined && !deleteMutation.isPending) {
        deleteMutation.mutate(tasks)
      }
    },
    edit: (task, content) => {
      if (graph?.generation !== undefined) {
        editMutation.mutate({ task, content })
      }
    },
    checkboxToggle: (task) => checkboxAction.toggle(task),
    insert: async (target) => {
      if (graph?.generation === undefined) {
        return null
      }
      return await insertInto(target)
    },
    insertAfter: async (task, content, target) => {
      if (graph?.generation === undefined) {
        return null
      }
      if (task.breadcrumbs.length > 0) {
        try {
          const created = await contextInsert.insert(task, content)
          if (created !== null) {
            return created
          }
        } catch {
          // Failure already surfaced; fall through to preserve the draft.
        }
        await persistTaskDraft(task, content)
        return null
      }
      // Resolve the current row first and *await* it, so the append reads the
      // settled source. Emptied content (the row was cleared) deletes that row
      // rather than leaving a bare `+ [ ]` ghost; a real change persists; null
      // (unchanged) is left be.
      if (!(await persistTaskDraft(task, content))) {
        return null // the edit/delete rollback already surfaced the failure
      }
      return await insertInto(target)
    },
    editAndToggle: (task, content) => {
      if (graph?.generation !== undefined && !editAndToggleMutation.isPending) {
        editAndToggleMutation.mutate({ task, content })
      }
    },
    schedule: (tasks, isoDate) => {
      if (tasks.length > 0 && graph?.generation !== undefined && !scheduleMutation.isPending) {
        scheduleMutation.mutate({ tasks, isoDate })
      }
    },
    convertToBullet: (tasks) => {
      if (tasks.length > 0 && graph?.generation !== undefined && !convertMutation.isPending) {
        convertMutation.mutate(tasks)
      }
    },
    editAndConvertToBullet: (task, content) => {
      if (graph?.generation !== undefined && !editAndConvertMutation.isPending) {
        editAndConvertMutation.mutate({ task, content })
      }
    },
    archive: () => archiveRecentlyCompleted(root),
  }
}
