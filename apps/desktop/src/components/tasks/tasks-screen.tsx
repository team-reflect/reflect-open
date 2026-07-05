import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { Archive, CalendarClock, List, Search } from 'lucide-react'
import {
  getCompletedTasks,
  getOpenTasks,
  hasBridge,
  type OpenTask,
  type TaskGroup,
} from '@reflect/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useRecentlyCompleted } from '@/lib/tasks/recently-completed'
import { sameTask, taskKey } from '@/lib/tasks/task-identity'
import { type InsertTaskTarget } from '@/lib/tasks/task-insert-target'
import { scrollTaskIntoView } from '@/lib/tasks/task-navigation'
import { useTaskActions } from '@/lib/tasks/use-task-actions'
import { useTaskRowHandlers } from '@/lib/tasks/use-task-row-handlers'
import { useTaskFilters } from '@/lib/tasks/task-filters'
import { composeVisibleTaskGroups } from '@/lib/tasks/task-visibility'
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
import { TaskScheduleCalendar } from './task-schedule-calendar'
import { TaskToolbarCountBadge } from './task-toolbar-count-badge'

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
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)
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

  // This session's completed tasks, still showing struck until archived —
  // reconciled against the open read so a task reopened at its source note
  // sheds its struck shadow instead of masking the live row.
  const recentlyCompleted = useRecentlyCompleted(graph?.root ?? null, open)

  const needle = query.trim().toLowerCase()
  const groups = useMemo(
    () =>
      composeVisibleTaskGroups({ open, completed, recentlyCompleted, filters, needle, today }),
    [open, completed, recentlyCompleted, filters, needle, today],
  )

  // The flat, render-order list of tasks the selection and its shortcuts act on.
  const orderedTasks = useMemo(() => groups.flatMap((group) => group.tasks), [groups])
  const orderedKeys = useMemo(() => orderedTasks.map(taskKey), [orderedTasks])
  const tasksByKey = useMemo(
    () => new Map(orderedTasks.map((task) => [taskKey(task), task])),
    [orderedTasks],
  )
  const selection = useTaskSelection(orderedKeys)
  // Close the schedule popover when the selection it acts on goes away (e.g. a
  // reindex prunes the selected row): the toolbar trigger and the calendar unmount
  // together, so a lingering `scheduleOpen` would remount it open on re-select.
  if (scheduleOpen && selection.selectedCount === 0) {
    setScheduleOpen(false)
  }
  const actions = useTaskActions()
  const scrollToKey = useCallback((key: string | null) => {
    if (key !== null) {
      scrollTaskIntoView(rootRef.current, key)
    }
  }, [])
  const editHandlers = useTaskRowHandlers({ selection, actions, orderedTasks, today, scrollToKey })
  const selectedTaskKeys = selection.selected
  const activeTaskKey = selection.activeKey
  // Selection opens the focused task's inline editor, often after an async insert
  // and optimistic cache render. Scroll after the DOM reflects that selection so
  // the focused row is always visible.
  useLayoutEffect(() => {
    scrollToKey(focusedSelectedKey(selectedTaskKeys, activeTaskKey))
  }, [activeTaskKey, orderedKeys, scrollToKey, selectedTaskKeys])
  // The group headers' "+ Add" (V1): drop any search filter so the new row is
  // visible, write it, then select it so its editor opens focused.
  const onAdd = useCallback(
    (target: InsertTaskTarget) => {
      setQuery('')
      void actions.insert(target).then((created) => {
        if (created !== null) {
          const key = taskKey(created)
          selection.clickSelect(key, { metaKey: false, ctrlKey: false, shiftKey: false })
          scrollToKey(key)
        }
      })
    },
    [actions, selection, scrollToKey],
  )
  // The tasks behind the current selection's keys, in selection order — what the
  // toolbar actions (schedule, convert) act on. A row whose key no longer
  // resolves (pruned by a reindex) is dropped rather than acted on.
  const selectedTasks = useCallback(
    (): OpenTask[] =>
      [...selection.selected]
        .map((key) => tasksByKey.get(key))
        .filter((task): task is OpenTask => task !== undefined),
    [selection, tasksByKey],
  )
  const onSelectionCheckboxToggle = useCallback(
    (task: OpenTask) => {
      const tasks = selectedTasks()
      if (tasks.length <= 1 || !tasks.some((selectedTask) => sameTask(selectedTask, task))) {
        actions.checkboxToggle(task)
        return
      }
      if (task.checked) {
        actions.toggle(tasks.filter((selectedTask) => selectedTask.checked))
      } else {
        actions.complete(tasks)
      }
    },
    [actions, selectedTasks],
  )
  // Schedule the current selection (the calendar / ⌘⇧S), then deselect (V1).
  const onSchedule = useCallback(
    (isoDate: string | null) => {
      actions.schedule(selectedTasks(), isoDate)
      selection.clear()
    },
    [actions, selection, selectedTasks],
  )
  // Convert the current selection to plain bullets (the toolbar / ⌘⇧K): the rows
  // leave the Tasks view, so deselect after, like scheduling. When a single row is
  // being inline-edited it holds a flush-then-convert trigger here — route through
  // it so the unsaved draft is saved first, never written stale by the convert
  // landing ahead of the editor's commit (the keyboard ⌘⇧K hits the editor's own
  // keymap; this covers the toolbar button and an unfocused sole selection).
  const convertControllerRef = useRef<(() => void) | null>(null)
  const onConvertToBullet = useCallback(() => {
    const convertEditing = convertControllerRef.current
    if (convertEditing !== null) {
      convertEditing()
    } else {
      actions.convertToBullet(selectedTasks())
      selection.clear()
    }
  }, [actions, selection, selectedTasks])
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
    onToggleFilters: () => setFiltersOpen((open) => !open),
    onToggleSchedule: () => setScheduleOpen((open) => !open),
    onConvertToBullet,
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
            onSchedule={onSchedule}
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
            onClick={onConvertToBullet}
            title="Drop the checkbox, keeping the line as a plain bullet — leaves the Tasks list"
            className="window-drag-control text-xs text-text-muted"
          >
            <List aria-hidden className="size-3.5" />
            Convert to bullet
            <TaskToolbarCountBadge count={selection.selectedCount} />
          </Button>
        ) : null}
        {recentlyCompleted.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            aria-label={`Archive ${recentlyCompleted.length}`}
            onClick={actions.archive}
            className="window-drag-control text-xs text-text-muted"
          >
            <Archive aria-hidden className="size-3.5" />
            Archive
            <TaskToolbarCountBadge count={recentlyCompleted.length} />
          </Button>
        ) : null}
        <TaskFiltersMenu
          filters={filters}
          toggle={toggle}
          open={filtersOpen}
          onOpenChange={setFiltersOpen}
        />
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
          <div className="flex flex-col gap-5">
            {groups.map((group: TaskGroup) => (
              <TaskGroupSection
                key={group.kind === 'note' ? `note:${group.notePath}` : group.kind}
                group={group}
                selection={selection}
                editHandlers={editHandlers}
                taskActionPending={actions.isPending}
                onSelectionCheckboxToggle={onSelectionCheckboxToggle}
                today={today}
                onAdd={onAdd}
                convertControllerRef={convertControllerRef}
                onOpen={(path) => navigate(routeForPath(path))}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
