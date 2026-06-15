import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Archive, Search } from 'lucide-react'
import { getCompletedTasks, getOpenTasks, groupTasks, hasBridge, type TaskGroup } from '@reflect/core'
import { Input } from '@/components/ui/input'
import { useRecentlyCompleted } from '@/lib/tasks/recently-completed'
import { sameTask, taskKey } from '@/lib/tasks/task-identity'
import { scrollTaskIntoView } from '@/lib/tasks/task-navigation'
import { useTaskActions } from '@/lib/tasks/use-task-actions'
import { useTaskRowHandlers } from '@/lib/tasks/use-task-row-handlers'
import { useTaskFilters, type TaskFilters } from '@/lib/tasks/task-filters'
import { useTaskKeyboard } from '@/lib/tasks/use-task-keyboard'
import { useTaskSelection } from '@/lib/tasks/use-task-selection'
import { completedTasksQueryKey, tasksQueryKey } from '@/lib/tasks/tasks-query'
import { useScrollRestoration } from '@/lib/use-scroll-restoration'
import { useToday } from '@/lib/use-today'
import { useGraph } from '@/providers/graph-provider'
import { routeForPath } from '@/routing/route'
import { useRouter } from '@/routing/router'
import { TaskFiltersMenu } from './task-filters-menu'
import { TaskGroupSection } from './task-group-section'

/** Keep only the groups the active filters allow (V1's per-bucket toggles). */
function visibleGroups(groups: TaskGroup[], filters: TaskFilters): TaskGroup[] {
  return groups.filter((group) => {
    switch (group.kind) {
      case 'current':
        return filters.current
      case 'overdue':
        return filters.overdue
      case 'upcoming':
        return filters.upcoming
      case 'note':
        return group.tasks[0]?.isPinned ? filters.pinned : filters.other
    }
  })
}

/**
 * The Tasks view (Plan 18), in V1's design: every open checkbox across the graph
 * grouped into sticky, colour-coded sections — Current / Overdue / Upcoming (by
 * the task's due date, else its note's daily date) and then by note — read from
 * the SQLite projection and kept fresh by the index invalidation hook. A search
 * box filters by text; the "Task filters" menu toggles which buckets show and
 * reveals completed ("archived") tasks. Owns its scroll container so the sticky
 * headers and the toolbar stay put; per-entry scroll memory mirrors All Notes.
 *
 * Rows are multi-selectable (V1 parity): click to select, ⌘/Shift to extend, and
 * keyboard shortcuts act on the selection — ⌘A select all, ↑/↓ (Shift to extend),
 * ⌘↵ complete, ⌘⌫ delete (plain ⌫ deletes only empty rows), Esc clear. A sole
 * selection opens the inline editor.
 *
 * Completing a task keeps it showing (struck) in place — V1's middle state — via
 * the session-scoped {@link useRecentlyCompleted} set, until "Archive" (⌘⇧↵)
 * hides this run's completed tasks. They stay `[x]` on disk and remain under the
 * "show archived" filter, which reveals the whole completed history.
 */
export function TasksScreen(): ReactElement {
  const { graph } = useGraph()
  const { navigate } = useRouter()
  const today = useToday()
  const { filters, toggle } = useTaskFilters()
  const [query, setQuery] = useState('')
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
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

  // Either read failing surfaces the alert — a failed completed read must not
  // leave `ready` stuck (and the list blank) just because its data never arrived.
  // The completed error only counts while archived is on: TanStack keeps the last
  // error on the disabled query, so turning archived off must clear it.
  const isError = openFailed || (filters.archived && completedFailed)
  // When archived is on, the list merges open + completed, so the empty state
  // must wait for both — else a graph with only completed tasks flashes "No
  // tasks to show." while the completed query is still loading.
  const ready = open !== undefined && (!filters.archived || completed !== undefined)
  const { onScroll } = useScrollRestoration(scrollElement, ready)

  // This session's completed tasks, still showing struck until archived.
  const recentlyCompleted = useRecentlyCompleted(graph?.root ?? null)

  const needle = query.trim().toLowerCase()
  const groups = useMemo(() => {
    if (open === undefined) {
      return []
    }
    // The struck "completed" rows. With archived on, the completed query is the
    // full history — but a just-completed task may not be in it until the reindex
    // refetches (and the query reloads blank when you first flip the filter on),
    // so union the session set on top, deduped, to keep this run's rows visible.
    // With archived off, the session set is the only source.
    const completedRows = filters.archived
      ? [
          ...(completed ?? []),
          ...recentlyCompleted.filter(
            (task) => !(completed ?? []).some((row) => sameTask(row, task)),
          ),
        ]
      : recentlyCompleted
    // Drop any open row that's also present there — a refetch can briefly restore a
    // just-completed task to the open cache before the reindex lands, and listing
    // it both open and struck collides React keys.
    const completedKeys = new Set(completedRows.map(taskKey))
    const all = [...open.filter((task) => !completedKeys.has(taskKey(task))), ...completedRows]
    const matched = needle ? all.filter((task) => task.text.toLowerCase().includes(needle)) : all
    return visibleGroups(groupTasks(matched, today), filters)
  }, [open, completed, recentlyCompleted, filters, needle, today])

  // The flat, render-order list of tasks the selection and its shortcuts act on.
  const orderedTasks = useMemo(() => groups.flatMap((group) => group.tasks), [groups])
  const orderedKeys = useMemo(() => orderedTasks.map(taskKey), [orderedTasks])
  const tasksByKey = useMemo(
    () => new Map(orderedTasks.map((task) => [taskKey(task), task])),
    [orderedTasks],
  )
  const selection = useTaskSelection(orderedKeys)
  const actions = useTaskActions()
  const scrollToKey = useCallback((key: string | null) => {
    if (key !== null) {
      scrollTaskIntoView(rootRef.current, key)
    }
  }, [])
  const editHandlers = useTaskRowHandlers({ selection, actions, orderedTasks, scrollToKey })
  useTaskKeyboard({
    selection,
    actions,
    tasksByKey,
    orderedTasks,
    query,
    setQuery,
    today,
    rootRef,
    scrollToKey,
  })

  // Move focus into the Tasks surface on mount so the shortcuts work the moment
  // you navigate here — without it, focus would linger on the sidebar link that
  // navigated, where the scoping guard (rightly) backs the shortcuts off.
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      aria-label="Tasks"
      className="flex h-full min-h-0 flex-col outline-none"
    >
      <header className="flex flex-none items-center gap-2 border-b border-border py-2.5 pl-2 pr-3 lg:pl-10">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-muted"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search..."
            aria-label="Search tasks"
            className="h-9 border-none bg-transparent pl-8 shadow-none focus-visible:ring-0"
          />
        </div>
        {recentlyCompleted.length > 0 ? (
          <button
            type="button"
            onClick={actions.archive}
            className="flex flex-none items-center gap-2 rounded-md px-2 py-1 text-sm text-text-muted transition-colors hover:text-text focus-visible:text-text focus-visible:outline-none"
          >
            <Archive aria-hidden className="size-4" />
            Archive ({recentlyCompleted.length})
          </button>
        ) : null}
        <TaskFiltersMenu filters={filters} toggle={toggle} />
      </header>
      <div
        ref={setScrollElement}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto pb-8"
      >
        {isError ? (
          <p role="alert" className="px-4 py-6 text-sm text-text-muted lg:px-12">
            Couldn’t load tasks.
          </p>
        ) : ready && groups.length === 0 ? (
          <p className="px-4 py-6 text-sm text-text-muted lg:px-12">
            {needle ? 'No matching tasks.' : 'No tasks to show.'}
          </p>
        ) : (
          groups.map((group: TaskGroup) => (
            <TaskGroupSection
              key={group.kind === 'note' ? `note:${group.notePath}` : group.kind}
              group={group}
              selection={selection}
              editHandlers={editHandlers}
              onOpen={(path) => navigate(routeForPath(path))}
            />
          ))
        )}
      </div>
    </div>
  )
}
