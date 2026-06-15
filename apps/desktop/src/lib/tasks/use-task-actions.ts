import { useMutation } from '@tanstack/react-query'
import { type OpenTask } from '@reflect/core'
import { deleteTask, editTask, insertTask, toggleTask } from '@/lib/note-task'
import {
  archiveRecentlyCompleted,
  forgetRecentlyCompleted,
  markRecentlyCompleted,
} from '@/lib/tasks/recently-completed'
import { asCompleted, taskRawWithContent, withEditedTask, withoutTasks } from '@/lib/tasks/task-cache'
import { taskKey } from '@/lib/tasks/task-identity'
import { useTaskCacheWriter } from '@/lib/tasks/use-task-cache'
import { useGraph } from '@/providers/graph-provider'

/**
 * The note a new task is added to (Return-to-add, V1): its path plus the context
 * the optimistic row needs to render and bucket before the reindex — the same
 * fields {@link OpenTask} carries beyond the marker itself.
 */
export interface InsertTaskTarget {
  notePath: string
  noteTitle: string
  dailyDate: string | null
  isPinned: boolean
  pinnedOrder: number | null
}

/**
 * Bulk task actions for the Tasks view's keyboard shortcuts (Plan 18): complete
 * a selection (⌘↵), delete a selection (⌫/⌘⌫), edit one task from the inline
 * editor, and add a task (Return). They update the open and completed caches
 * optimistically through the shared {@link useTaskCacheWriter} — the same path
 * single-row {@link useCompleteTask} takes — so the selection reacts instantly,
 * then the reindex reconciles. A failed write rolls every row back and surfaces
 * the reason once.
 *
 * Writes within a batch run **sequentially**: tasks can share a note, and two
 * concurrent edits to one file would race (the loser's read predates the
 * winner's write). The core edits relocate by the task's `raw`, so the offset
 * drift a prior edit causes in the same note is tolerated, not a wrong write.
 */
export interface TaskActions {
  complete: (tasks: OpenTask[]) => void
  remove: (tasks: OpenTask[]) => void
  /** Replace one task's content from the inline editor (Plan 18). */
  edit: (task: OpenTask, content: string) => void
  /**
   * Add a new empty task to `target`'s note (Return-to-add, V1) and return the
   * optimistic row to select — its inline editor opens focused. Resolves to
   * `null` when there's no graph or the write failed (the toast already fired).
   */
  insert: (target: InsertTaskTarget) => Promise<OpenTask | null>
  /**
   * Save an inline edit and complete the task in one go (⌘↵ while editing). The
   * two writes run **sequentially** — edit then toggle the rebuilt line — so they
   * can't race each other on the same note line.
   */
  editAndComplete: (task: OpenTask, content: string) => void
  /** Archive (⌘⇧↵): stop showing the session's completed tasks in the active list. */
  archive: () => void
  isPending: boolean
}

export function useTaskActions(): TaskActions {
  const { graph } = useGraph()
  const root = graph?.root ?? null
  const cache = useTaskCacheWriter()

  const completeMutation = useMutation({
    mutationFn: async (tasks: OpenTask[]) => {
      const generation = graph?.generation
      if (generation === undefined) {
        throw new Error('No graph is open.')
      }
      for (const task of tasks) {
        await toggleTask(task, generation)
      }
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
      forgetRecentlyCompleted(root, tasks.map(taskKey))
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (tasks: OpenTask[]) => {
      const generation = graph?.generation
      if (generation === undefined) {
        throw new Error('No graph is open.')
      }
      for (const task of tasks) {
        await deleteTask(task, generation)
      }
    },
    onMutate: async (tasks: OpenTask[]) => {
      const snapshot = await cache.snapshot()
      // A delete removes the task from both lists outright.
      cache.patch(
        (rows) => withoutTasks(rows, tasks),
        (rows) => withoutTasks(rows, tasks),
      )
      // A deleted task must not linger struck in the session's completed set.
      forgetRecentlyCompleted(root, tasks.map(taskKey))
      return snapshot
    },
    onError: (cause) => cache.reconcile('Deleting tasks', cause),
  })

  const editMutation = useMutation({
    mutationFn: ({ task, content }: { task: OpenTask; content: string }) => {
      const generation = graph?.generation
      if (generation === undefined) {
        throw new Error('No graph is open.')
      }
      return editTask(task, content, generation)
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

  const insertMutation = useMutation({
    mutationFn: (target: InsertTaskTarget) => {
      const generation = graph?.generation
      if (generation === undefined) {
        throw new Error('No graph is open.')
      }
      return insertTask(target.notePath, generation)
    },
    onError: (cause) => cache.reconcile('Adding task', cause),
  })

  // Build the optimistic open row for a just-written task. Its `raw` is the empty
  // checkbox the parser will record (`[ ] ` — trailing space and all), so a
  // follow-up edit's staleness guard matches disk before the reindex lands.
  const insertedRow = (target: InsertTaskTarget, markerOffset: number): OpenTask => ({
    notePath: target.notePath,
    markerOffset,
    raw: '[ ] ',
    checked: false,
    text: '',
    noteTitle: target.noteTitle,
    dueDate: null,
    dailyDate: target.dailyDate,
    isPinned: target.isPinned,
    pinnedOrder: target.pinnedOrder,
    updatedAt: Date.now(),
  })

  const editAndCompleteMutation = useMutation({
    mutationFn: async ({ task, content }: { task: OpenTask; content: string }) => {
      const generation = graph?.generation
      if (generation === undefined) {
        throw new Error('No graph is open.')
      }
      // Edit, then toggle the *rewritten* line — sequential, and the toggle is
      // given the post-edit `raw` so it locates the line the edit just wrote
      // (the marker offset is unchanged; only the content after it moved).
      await editTask(task, content, generation)
      await toggleTask({ ...task, raw: taskRawWithContent(task, content) }, generation)
    },
    onMutate: async ({ task, content }: { task: OpenTask; content: string }) => {
      const snapshot = await cache.snapshot()
      // Surface the *edited* row struck (its new text), in both the completed
      // cache (archived on) and the session set (off) — not the pre-edit task.
      const edited = withEditedTask([task], task, content)?.[0] ?? task
      cache.patch(
        (rows) => withoutTasks(rows, [task]),
        (rows) => asCompleted(rows, [edited]),
      )
      markRecentlyCompleted(root, [edited])
      return snapshot
    },
    onError: (cause, { task }) => {
      // Two sequential writes (edit then toggle) — if the toggle fails after the
      // edit lands, refetch rather than roll back over the persisted edit.
      cache.reconcile('Completing task', cause)
      forgetRecentlyCompleted(root, [taskKey(task)])
    },
  })

  return {
    isPending:
      completeMutation.isPending ||
      deleteMutation.isPending ||
      editMutation.isPending ||
      editAndCompleteMutation.isPending ||
      insertMutation.isPending,
    complete: (tasks) => {
      // ⌘↵ *completes*; with archived rows in the selection, toggling an
      // already-checked task would reopen it on disk. Only act on open rows.
      const open = tasks.filter((task) => !task.checked)
      if (open.length > 0 && graph?.generation !== undefined && !completeMutation.isPending) {
        completeMutation.mutate(open)
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
    insert: async (target) => {
      if (graph?.generation === undefined) {
        return null
      }
      let markerOffset: number
      try {
        markerOffset = await insertMutation.mutateAsync(target)
      } catch {
        return null // reconcile already surfaced the failure
      }
      const created = insertedRow(target, markerOffset)
      cache.addOpen(created)
      return created
    },
    editAndComplete: (task, content) => {
      if (graph?.generation !== undefined && !editAndCompleteMutation.isPending) {
        editAndCompleteMutation.mutate({ task, content })
      }
    },
    archive: () => archiveRecentlyCompleted(root),
  }
}
