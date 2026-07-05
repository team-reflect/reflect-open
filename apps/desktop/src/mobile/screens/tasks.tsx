import { useDeferredValue, useMemo, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Archive, CircleCheck, Plus, SlidersHorizontal } from 'lucide-react'
import {
  getCompletedTasks,
  getOpenTasks,
  hasBridge,
  type OpenTask,
} from '@reflect/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useRecentlyCompleted } from '@/lib/tasks/recently-completed'
import { taskKey } from '@/lib/tasks/task-identity'
import { useTaskFilters } from '@/lib/tasks/task-filters'
import { type InsertTaskTarget } from '@/lib/tasks/task-insert-target'
import { todaysDailyTarget } from '@/lib/tasks/task-navigation'
import { composeVisibleTaskGroups } from '@/lib/tasks/task-visibility'
import { completedTasksQueryKey, tasksQueryKey } from '@/lib/tasks/tasks-query'
import { useTaskActions } from '@/lib/tasks/use-task-actions'
import { useToday } from '@/lib/use-today'
import { MobileTaskEditSheet } from '@/mobile/task-edit-sheet'
import { TaskFiltersDrawer } from '@/mobile/task-filters-drawer'
import { MobileTaskGroup } from '@/mobile/task-group'
import { useGraph } from '@/providers/graph-provider'
import { routeForPath } from '@/routing/route'
import { useRouter } from '@/routing/router'

/**
 * The Tasks tab (V1 mobile's third tab over Plan 18's shipped data layer): every
 * open task across the graph in desktop's exact groups — Current / Overdue /
 * Upcoming, then per-note — via the same queries, grouping
 * ({@link composeVisibleTaskGroups}) and optimistic mutations
 * ({@link useTaskActions}) the desktop view uses; this screen adds only the
 * touch surface. Checkboxes toggle with a light haptic; tapping a row opens the
 * quick-edit sheet (edit / schedule / complete / convert / open note) instead of
 * desktop's multi-select; the filter sheet carries desktop's bucket toggles and
 * "Show archived". Completing keeps the row struck (V1's middle state) until
 * Archive hides this session's completed tasks.
 */
export function MobileTasks(): ReactElement {
  const { graph } = useGraph()
  const { navigate } = useRouter()
  const today = useToday()
  const { filters, toggle } = useTaskFilters()
  const [query, setQuery] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  // The sheet's task sticks around after close so the exit animation has
  // content; `sheetOpen` alone drives visibility.
  const [editingTask, setEditingTask] = useState<OpenTask | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  // Whether the current sheet visit should open with the editor focused
  // (keyboard up) — set per visit: true for "+"-added tasks, false for row taps.
  const [autoFocusEditor, setAutoFocusEditor] = useState(false)
  const enabled = hasBridge() && graph !== null

  const { data: open, isError: openFailed } = useQuery({
    queryKey: tasksQueryKey(graph?.root),
    queryFn: () => getOpenTasks(),
    enabled,
  })
  const { data: completed, isError: completedFailed } = useQuery({
    queryKey: completedTasksQueryKey(graph?.root),
    queryFn: () => getCompletedTasks(),
    enabled: enabled && filters.archived,
  })
  const isError = openFailed || (filters.archived && completedFailed)
  const ready = open !== undefined && (!filters.archived || completed !== undefined)

  const recentlyCompleted = useRecentlyCompleted(graph?.root ?? null, open)
  const actions = useTaskActions()

  // Defer the needle like the All tab defers its query: fast typing coalesces
  // while the input stays live. A cleared query applies immediately — the "+"
  // add clears it so the new row is visible, and a stale deferred needle must
  // not keep hiding that row while it catches up.
  const deferredQuery = useDeferredValue(query)
  const needle = (query === '' ? '' : deferredQuery).trim().toLowerCase()
  const groups = useMemo(
    () =>
      composeVisibleTaskGroups({ open, completed, recentlyCompleted, filters, needle, today }),
    [open, completed, recentlyCompleted, filters, needle, today],
  )

  // The sheet edits the task's *live* row, not the snapshot taken when it
  // opened: a mutation or reindex can rewrite the row (raw, checked) while
  // `editingTask` is set, and acting on the stale copy could flip a marker the
  // wrong way or trip the write-back guard needlessly. Fall back to the
  // snapshot when the row left the lists — the raw-match guard then refuses
  // any write that no longer applies.
  const liveEditingTask = useMemo(() => {
    if (editingTask === null) {
      return null
    }
    const key = taskKey(editingTask)
    return (
      groups.flatMap((group) => group.tasks).find((row) => taskKey(row) === key) ?? editingTask
    )
  }, [groups, editingTask])

  const editTask = (task: OpenTask, options?: { autoFocus?: boolean }): void => {
    setAutoFocusEditor(options?.autoFocus === true)
    setEditingTask(task)
    setSheetOpen(true)
  }

  // The group headers' "+" (V1): drop any search filter so the new row is
  // visible, write it, then open its quick-edit sheet with the editor focused
  // so typing starts immediately.
  const onAdd = (target: InsertTaskTarget): void => {
    setQuery('')
    void actions.insert(target).then((created) => {
      if (created !== null) {
        editTask(created, { autoFocus: true })
      }
    })
  }

  return (
    <div
      className="flex h-full w-screen flex-col"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <header className="flex shrink-0 items-center gap-1 border-b border-border px-4 pb-2 pt-1">
        <Input
          type="search"
          inputMode="search"
          placeholder="Search tasks…"
          aria-label="Search tasks"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="text-base"
        />
        {recentlyCompleted.length > 0 ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-10 shrink-0"
            aria-label={`Archive ${recentlyCompleted.length} completed`}
            onClick={actions.archive}
          >
            <Archive />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="size-10 shrink-0"
          aria-label="Task filters"
          onClick={() => setFiltersOpen(true)}
        >
          <SlidersHorizontal />
        </Button>
      </header>
      {isError ? (
        <p role="alert" className="px-4 py-6 text-sm text-text-muted">
          Couldn’t load tasks.
        </p>
      ) : enabled && !ready && groups.length === 0 ? (
        // Loading only gates what would otherwise be a false empty state: with
        // archived flipping on, the open groups keep showing while the
        // completed history loads (desktop likewise gates only the message).
        <div className="flex flex-1 items-center justify-center" aria-label="Loading tasks">
          <Spinner className="size-5 text-text-muted" />
        </div>
      ) : groups.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-text-muted">
          <CircleCheck className="size-6" />
          <p className="text-sm">{needle ? 'No matching tasks' : 'No tasks to show'}</p>
          {needle === '' ? (
            <Button variant="outline" onClick={() => onAdd(todaysDailyTarget(today))}>
              Add a task
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pb-24">
          {groups.map((group) => (
            <MobileTaskGroup
              key={group.kind === 'note' ? `note:${group.notePath}` : group.kind}
              group={group}
              today={today}
              onAdd={onAdd}
              onEdit={editTask}
              onOpen={(path) => navigate(routeForPath(path))}
            />
          ))}
        </div>
      )}
      <Button
        size="icon"
        aria-label="New task"
        className="fixed right-4 z-40 size-12 rounded-full shadow-lg"
        style={{ bottom: 'calc(max(env(safe-area-inset-bottom), var(--keyboard-height, 0px)) + 4.25rem)' }}
        onClick={() => onAdd(todaysDailyTarget(today))}
      >
        <Plus className="size-6" />
      </Button>
      {liveEditingTask !== null ? (
        <MobileTaskEditSheet
          key={taskKey(liveEditingTask)}
          task={liveEditingTask}
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          today={today}
          actions={actions}
          onOpenNote={(path) => navigate(routeForPath(path))}
          autoFocusEditor={autoFocusEditor}
        />
      ) : null}
      <TaskFiltersDrawer
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        filters={filters}
        toggle={toggle}
      />
    </div>
  )
}
