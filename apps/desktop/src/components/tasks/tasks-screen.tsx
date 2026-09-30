import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react'
import { Archive, CalendarClock, List, Search } from 'lucide-react'
import type { TaskGroup, TaskTarget } from '@reflect/core'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import { useTaskList } from '@/lib/tasks/use-task-list.ts'
import { scrollTaskIntoView } from '@/lib/tasks/task-navigation.ts'
import { useTaskCommands } from '@/lib/tasks/use-task-commands.ts'
import { useTaskFilters } from '@/lib/tasks/task-filters.ts'
import { composeVisibleTaskGroups } from '@/lib/tasks/task-visibility.ts'
import { useTaskKeyboard } from '@/lib/tasks/use-task-keyboard.ts'
import { useListSelection } from '@/lib/selection/use-list-selection.ts'
import { useScrollRestoration } from '@/lib/use-scroll-restoration.ts'
import { useToday } from '@/lib/use-today.ts'
import type { ModClickEvent } from '@/lib/windows/open-in-new-window.ts'
import { routeForPath } from '@/routing/route.ts'
import { TaskFiltersMenu } from './task-filters-menu.tsx'
import { TaskGroupSection } from './task-group-section.tsx'
import { TaskScheduleCalendar } from './task-schedule-calendar.tsx'
import { TaskToolbarCountBadge } from './task-toolbar-count-badge.tsx'
import { isModEvent } from '@meowdown/core'

/** The selected task that owns keyboard focus: the cursor/anchor, else the first row left selected. */
function focusedSelectedKey(
  selectedTaskKeys: ReadonlySet<string>,
  activeTaskKey: () => string | null,
): string | null {
  const activeKey = activeTaskKey()
  if (activeKey !== null && selectedTaskKeys.has(activeKey)) {
    return activeKey
  }
  const first = selectedTaskKeys.values().next()
  return first.done ? null : first.value
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
 * the task store, until "Archive" (⌘⇧↵)
 * hides this run's completed tasks. They stay `[x]` on disk and remain under the
 * "show archived" filter, which reveals the whole completed history.
 */
export function TasksScreen(): ReactElement {
  const navigateNoteLink = useNoteLinkNavigation()
  const today = useToday()
  const { filters, toggle } = useTaskFilters()
  const [query, setQuery] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const { store, tasks, ready, isError, recentCount } = useTaskList(filters.archived)
  const { onScroll } = useScrollRestoration(scrollElement, ready)

  const needle = query.trim().toLowerCase()
  const groups = useMemo(
    () => composeVisibleTaskGroups({ tasks, filters, needle, today }),
    [tasks, filters, needle, today],
  )

  // The flat, render-order list of tasks the selection and its shortcuts act on.
  const orderedTasks = useMemo(() => groups.flatMap((group) => group.tasks), [groups])
  const orderedKeys = useMemo(() => orderedTasks.map((task) => task.key), [orderedTasks])
  const tasksByKey = useMemo(
    () => new Map(orderedTasks.map((task) => [task.key, task])),
    [orderedTasks],
  )
  const selection = useListSelection(orderedKeys)
  // Close the schedule popover when the selection it acts on goes away (e.g. a
  // reindex prunes the selected row): the toolbar trigger and the calendar unmount
  // together, so a lingering `scheduleOpen` would remount it open on re-select.
  if (scheduleOpen && selection.selectedCount === 0) {
    setScheduleOpen(false)
  }
  const scrollToKey = useCallback((key: string | null) => {
    if (key !== null) {
      scrollTaskIntoView(rootRef.current, key)
    }
  }, [])
  const selectedTaskKeys = selection.selected
  const activeTaskKey = selection.activeKey
  // Selection opens the focused task's inline editor, often after an async insert
  // and optimistic cache render. Scroll after the DOM reflects that selection so
  // the focused row is always visible.
  useLayoutEffect(() => {
    scrollToKey(focusedSelectedKey(selectedTaskKeys, activeTaskKey))
  }, [activeTaskKey, orderedKeys, scrollToKey, selectedTaskKeys])
  const commands = useTaskCommands({
    store,
    selection,
    tasksByKey,
    orderedTasks,
    today,
    scrollToKey,
  })
  // The group headers' "+ Add" (V1): drop any search filter so the new row is visible.
  const onAdd = useCallback(
    (target: TaskTarget) => {
      setQuery('')
      commands.add(target)
    },
    [commands],
  )
  const openNote = useCallback(
    (path: string, event?: ModClickEvent) =>
      navigateNoteLink({
        target: routeForPath(path),
        openInNewWindow: event !== undefined && isModEvent(event),
      }),
    [navigateNoteLink],
  )
  useTaskKeyboard({
    selection,
    commands,
    query,
    setQuery,
    rootRef,
    onToggleFilters: () => setFiltersOpen((open) => !open),
    onToggleSchedule: () => setScheduleOpen((open) => !open),
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
        <div className="window-drag-control min-w-0 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-muted"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search..."
            aria-label="Search tasks"
            className="h-9 border-none bg-transparent pl-8 shadow-none focus-visible:ring-0"
          />
        </div>
        {selection.selectedCount > 0 ? (
          <TaskScheduleCalendar
            open={scheduleOpen}
            onOpenChange={setScheduleOpen}
            today={today}
            onSchedule={commands.schedule}
          >
            <Button
              type="button"
              variant="ghost"
              aria-label={`Schedule ${selection.selectedCount}`}
              className="window-drag-control text-xs text-text-muted"
            >
              <CalendarClock aria-hidden className="size-3.5" />
              Schedule
              <TaskToolbarCountBadge count={selection.selectedCount} />
            </Button>
          </TaskScheduleCalendar>
        ) : null}
        {selection.selectedCount > 0 ? (
          <Button
            type="button"
            variant="ghost"
            aria-label={`Convert to bullet ${selection.selectedCount}`}
            onClick={commands.convert}
            title="Drop the checkbox, keeping the line as a plain bullet — leaves the Tasks list"
            className="window-drag-control text-xs text-text-muted"
          >
            <List aria-hidden className="size-3.5" />
            Convert to bullet
            <TaskToolbarCountBadge count={selection.selectedCount} />
          </Button>
        ) : null}
        {recentCount > 0 ? (
          <Button
            type="button"
            variant="ghost"
            aria-label={`Archive ${recentCount}`}
            onClick={commands.archive}
            className="window-drag-control text-xs text-text-muted"
          >
            <Archive aria-hidden className="size-3.5" />
            Archive
            <TaskToolbarCountBadge count={recentCount} />
          </Button>
        ) : null}
        <TaskFiltersMenu
          filters={filters}
          toggle={toggle}
          open={filtersOpen}
          onOpenChange={setFiltersOpen}
        />
      </header>
      <div ref={setScrollElement} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto pb-8">
        {isError ? (
          <p role="alert" className="px-4 py-6 text-sm text-text-muted lg:px-12">
            Couldn’t load tasks.
          </p>
        ) : ready && groups.length === 0 ? (
          <p className="px-4 py-6 text-sm text-text-muted lg:px-12">
            {needle ? 'No matching tasks.' : 'No tasks to show.'}
          </p>
        ) : (
          <div className="flex flex-col gap-5">
            {groups.map((group: TaskGroup) => (
              <TaskGroupSection
                key={group.kind === 'note' ? `note:${group.notePath}` : group.kind}
                group={group}
                selection={selection}
                commands={commands}
                today={today}
                onAdd={onAdd}
                onOpen={openNote}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
