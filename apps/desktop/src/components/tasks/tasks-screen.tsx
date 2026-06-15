import { useEffect, useRef, type KeyboardEvent, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getOpenTasks, groupTasks, hasBridge } from '@reflect/core'
import { tasksQueryKey } from '@/lib/tasks/tasks-query'
import { useToday } from '@/lib/use-today'
import { useGraph } from '@/providers/graph-provider'
import { routeForPath } from '@/routing/route'
import { useRouter } from '@/routing/router'
import { TaskGroupSection } from './task-group-section'

/** Roving focus: ↑/↓ move between task rows so the whole view is mouse-free. */
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
    event.key === 'ArrowDown'
      ? Math.min(current + 1, rows.length - 1)
      : Math.max(current - 1, 0)
  rows[current < 0 ? 0 : next]?.focus()
}

/**
 * The Tasks view (Plan 18): every open checkbox across the graph, grouped
 * Current / Overdue / Upcoming (by the source note's daily date) and then by
 * note, read from the SQLite projection and kept fresh by the index
 * invalidation hook — no polling. Completing a task from here lands in PR3, so
 * the rows open their source note for now. Owns its scroll container so the
 * header stays put; per-entry scroll memory mirrors All Notes.
 */
export function TasksScreen(): ReactElement {
  const { graph } = useGraph()
  const { arrivalSeq, entryId, navigate, saveScrollState, savedScroll } = useRouter()
  const today = useToday()
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const { data: tasks, isError } = useQuery({
    queryKey: tasksQueryKey(graph?.root),
    queryFn: () => getOpenTasks(),
    enabled: hasBridge() && graph !== null,
  })

  // Restore the saved offset on back/forward; reset to the top on re-arrival
  // (the router clears the offset for that case). Gated on the rows being
  // loaded so a restore against an empty list can't clamp the position to 0.
  const ready = tasks !== undefined
  useEffect(() => {
    if (ready && scrollRef.current) {
      scrollRef.current.scrollTop = savedScroll() ?? 0
    }
  }, [arrivalSeq, entryId, ready, savedScroll])

  const groups = tasks ? groupTasks(tasks, today) : []

  return (
    <div aria-label="Tasks" className="flex h-full min-h-0 flex-col">
      <header className="flex flex-none items-center justify-between border-b border-border py-4 pl-4 pr-7 lg:pl-12">
        <h1 className="text-[15px] font-semibold text-text">Tasks</h1>
      </header>
      <div
        ref={scrollRef}
        onScroll={(event) => saveScrollState(event.currentTarget.scrollTop)}
        onKeyDown={moveTaskFocus}
        className="min-h-0 flex-1 overflow-auto px-4 py-6 lg:px-12"
      >
        {isError ? (
          <p role="alert" className="text-sm text-text-muted">
            Couldn’t load tasks.
          </p>
        ) : ready && groups.length === 0 ? (
          <p className="text-sm text-text-muted">No open tasks.</p>
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
