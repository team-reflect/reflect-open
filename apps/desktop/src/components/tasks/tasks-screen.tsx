import { useState, type KeyboardEvent, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { getCompletedTasks, getOpenTasks, groupTasks, hasBridge, type TaskGroup } from '@reflect/core'
import { Input } from '@/components/ui/input'
import { useTaskFilters, type TaskFilters } from '@/lib/tasks/task-filters'
import { completedTasksQueryKey, tasksQueryKey } from '@/lib/tasks/tasks-query'
import { useScrollRestoration } from '@/lib/use-scroll-restoration'
import { useToday } from '@/lib/use-today'
import { useGraph } from '@/providers/graph-provider'
import { routeForPath } from '@/routing/route'
import { useRouter } from '@/routing/router'
import { TaskFiltersMenu } from './task-filters-menu'
import { TaskGroupSection } from './task-group-section'

/** Roving focus: ↑/↓ move between task checkboxes so the whole view is mouse-free. */
function moveTaskFocus(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
    return
  }
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-task-row]')]
  if (rows.length === 0) {
    return
  }
  event.preventDefault()
  const current = rows.indexOf(document.activeElement as HTMLButtonElement)
  const next =
    event.key === 'ArrowDown' ? Math.min(current + 1, rows.length - 1) : Math.max(current - 1, 0)
  rows[current < 0 ? 0 : next]?.focus()
}

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
 */
export function TasksScreen(): ReactElement {
  const { graph } = useGraph()
  const { navigate } = useRouter()
  const today = useToday()
  const { filters, toggle } = useTaskFilters()
  const [query, setQuery] = useState('')
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const enabled = hasBridge() && graph !== null

  const { data: open, isError } = useQuery({
    queryKey: tasksQueryKey(graph?.root),
    queryFn: () => getOpenTasks(),
    enabled,
  })
  const { data: completed } = useQuery({
    queryKey: completedTasksQueryKey(graph?.root),
    queryFn: () => getCompletedTasks(),
    enabled: enabled && filters.archived,
  })

  const ready = open !== undefined
  const { onScroll } = useScrollRestoration(scrollElement, ready)

  const all = open ? (filters.archived && completed ? [...open, ...completed] : open) : []
  const needle = query.trim().toLowerCase()
  const matched = needle ? all.filter((task) => task.text.toLowerCase().includes(needle)) : all
  const groups = open ? visibleGroups(groupTasks(matched, today), filters) : []

  return (
    <div aria-label="Tasks" className="flex h-full min-h-0 flex-col">
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
        <TaskFiltersMenu filters={filters} toggle={toggle} />
      </header>
      <div
        ref={setScrollElement}
        onScroll={onScroll}
        onKeyDown={moveTaskFocus}
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
          groups.map((group) => (
            <TaskGroupSection
              key={group.kind === 'note' ? `note:${group.notePath}` : group.kind}
              group={group}
              onOpen={(path) => navigate(routeForPath(path))}
            />
          ))
        )}
      </div>
    </div>
  )
}
