import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
} from 'react'
import { Archive, CalendarClock, List, Search } from 'lucide-react'
import { errorMessage, type InsertTaskTarget, type OpenTask, type TaskGroup } from '@reflect/core'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { useNoteLinkNavigation, type ModClickEvent } from '@/hooks/use-note-link-navigation.ts'
import { useTaskRowHandlers } from '@/lib/tasks/use-task-row-handlers.ts'
import { useTaskFilters } from '@/lib/tasks/task-filters.ts'
import { getTaskMenuItems, runTaskMenuAction } from '@/lib/tasks/task-menu.ts'
import type { TaskListRow } from '@/lib/tasks/task-list-items.ts'
import { useTaskKeyboard } from '@/lib/tasks/use-task-keyboard.ts'
import { useTaskSelection } from '@/lib/tasks/use-task-selection.ts'
import { useVisibleTaskGroups } from '@/lib/tasks/use-visible-task-groups.ts'
import { useToday } from '@/lib/use-today.ts'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'
import { routeForPath } from '@reflect/app'
import { TaskFiltersMenu } from './task-filters-menu.tsx'
import { TaskBreadcrumbs } from './task-breadcrumbs.tsx'
import { TaskGroupHeader } from './task-group-header.tsx'
import { TaskList, type TaskListHandle } from './task-list.tsx'
import { TASK_ROW_HEIGHT, TaskRow } from './task-row.tsx'
import { TaskScheduleCalendar } from './task-schedule-calendar.tsx'
import { TaskToolbarCountBadge } from './task-toolbar-count-badge.tsx'
import { isModEvent } from '@meowdown/core'

/**
 * Space (px) between the last row of a group and the next group's header.
 */
const GROUP_GAP = 24

/**
 * The selected task that owns keyboard focus: the cursor/anchor, else the first row left selected.
 */
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
 * grouped under sticky, colour-coded headers — Current / Overdue / Upcoming (by
 * the task's due date, else its note's daily date) and then by note — read from
 * the SQLite projection and kept fresh by `TaskService`. A search
 * box filters by text; the "Task filters" menu toggles which buckets show and
 * reveals completed ("archived") tasks. The list scrolls inside `TaskList`,
 * so the toolbar stays put.
 *
 * Rows are multi-selectable (V1 parity): click to select, ⌘/Shift to extend, and
 * keyboard shortcuts act on the selection — ⌘A select all, ↑/↓ (Shift to extend),
 * ⌘↵ complete, ⌘⌫ delete (plain ⌫ deletes only empty rows), Esc clear. A sole
 * selection opens the inline editor.
 *
 * Completing a task keeps it showing (struck) in place — V1's middle state — via
 * the struck set of `TaskService`, until "Archive" (⌘⇧↵)
 * hides this run's completed tasks. They stay `[x]` on disk and remain under the
 * "show archived" filter, which reveals the whole completed history.
 */
export function TasksScreen(): ReactElement {
  const { tasks: taskService } = useCoreServices()
  const { commands } = taskService
  const { nativeMenu, operations } = useAppServices()
  const navigateNoteLink = useNoteLinkNavigation()
  const today = useToday()
  const { filters, toggle } = useTaskFilters()
  const [query, setQuery] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<TaskListHandle>(null)
  const needle = query.trim().toLowerCase()
  const { groups, ready, struck } = useVisibleTaskGroups({ needle, filters, today })

  // The flat, render-order list of tasks the selection and its shortcuts act on.
  const orderedTasks = useMemo(() => groups.flatMap((group) => group.tasks), [groups])
  const orderedKeys = useMemo(() => orderedTasks.map((task) => task.taskId), [orderedTasks])
  const tasksByKey = useMemo(
    () => new Map(orderedTasks.map((task) => [task.taskId, task])),
    [orderedTasks],
  )
  const selection = useTaskSelection(orderedKeys)
  // Close the schedule popover when the selection it acts on goes away (e.g. a
  // reindex prunes the selected row): the toolbar trigger and the calendar unmount
  // together, so a lingering `scheduleOpen` would remount it open on re-select.
  if (scheduleOpen && selection.selectedCount === 0) {
    setScheduleOpen(false)
  }
  const scrollToKey = useCallback((key: string | null) => {
    if (key !== null) {
      listRef.current?.revealTask(key)
    }
  }, [])
  const editHandlers = useTaskRowHandlers({ selection, orderedTasks, scrollToKey, setQuery })
  const {
    selected: selectedTaskKeys,
    selectedCount,
    activeKey,
    clickSelect,
    select,
    clear,
    getSelected,
  } = selection
  // Selection opens the focused task's inline editor, often after an async insert
  // and optimistic cache render. Scroll after the list holds that selection so
  // the focused row is always visible.
  const focusedKey = focusedSelectedKey(selectedTaskKeys, activeKey)
  useLayoutEffect(() => {
    scrollToKey(focusedKey)
  }, [focusedKey, orderedKeys, scrollToKey])
  // The sole selection: its row shows the inline editor.
  const editingTaskId = selectedCount === 1 ? focusedKey : null
  // The group headers' "+ Add" (V1): drop any search filter so the new row is
  // visible, then select it so its editor opens focused.
  const onAdd = useCallback(
    (target: InsertTaskTarget) => {
      setQuery('')
      const key = commands.add(target).taskId
      clickSelect(key, { metaKey: false, ctrlKey: false, shiftKey: false })
    },
    [commands, clickSelect],
  )
  // The tasks behind the current selection's keys, in selection order — what the
  // toolbar actions (schedule, convert) act on. A row whose key no longer
  // resolves (pruned by a reindex) is dropped rather than acted on.
  const selectedTasks = useCallback((): OpenTask[] => {
    return [...getSelected()]
      .map((key) => tasksByKey.get(key))
      .filter((task): task is OpenTask => task !== undefined)
  }, [getSelected, tasksByKey])
  // A checkbox click on a row of a multi-selection completes or reopens the
  // selected rows together. On any other row it toggles that row, with the text
  // typed into it, and ends the edit.
  const onCheckboxToggle = useCallback(
    (task: OpenTask) => {
      const tasks = selectedTasks()
      if (tasks.length > 1 && tasks.some((selectedTask) => selectedTask.taskId === task.taskId)) {
        if (task.checked) {
          void commands.toggle(tasks.filter((selectedTask) => selectedTask.checked))
        } else {
          void commands.complete(tasks)
        }
        return
      }
      void commands.toggle([task])
      const selected = getSelected()
      if (selected.size === 1 && selected.has(task.taskId)) {
        clear()
      }
    },
    [commands, selectedTasks, getSelected, clear],
  )
  // Schedule the current selection (the calendar / ⌘⇧S), then deselect (V1).
  const onSchedule = useCallback(
    (isoDate: string | null) => {
      void commands.schedule(selectedTasks(), isoDate)
      clear()
    },
    [commands, clear, selectedTasks],
  )
  // Convert the current selection to plain bullets (the toolbar / ⌘⇧K): the rows
  // leave the Tasks view, so deselect after, like scheduling.
  const onConvertToBullet = useCallback(() => {
    void commands.convert(selectedTasks())
    clear()
  }, [commands, clear, selectedTasks])
  const openNote = useCallback(
    (path: string, event?: ModClickEvent) => {
      navigateNoteLink({
        target: routeForPath(path),
        openInNewWindow: event !== undefined && isModEvent(event),
      })
    },
    [navigateNoteLink],
  )
  // A selected row targets the whole selection, any other row only itself without selecting it.
  const onListContextMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target as Element
      if (
        (target instanceof HTMLElement && target.isContentEditable) ||
        target.closest('input, textarea') !== null
      ) {
        return
      }
      const key = target.closest<HTMLElement>('[data-task-key]')?.dataset.taskKey
      const task = key === undefined ? undefined : tasksByKey.get(key)
      if (task === undefined) {
        return
      }
      event.preventDefault()
      const inSelection = getSelected().has(task.taskId)
      const tasks = inSelection ? selectedTasks() : [task]
      const clearSelection = (): void => {
        if (inSelection) {
          clear()
        }
      }
      void nativeMenu
        .openContextMenu({
          items: getTaskMenuItems(tasks, today),
          onSelect: (id) => {
            runTaskMenuAction(id, today, {
              toggle: () => {
                void commands.toggle(tasks)
              },
              schedule: (isoDate) => {
                void commands.schedule(tasks, isoDate)
                clearSelection()
              },
              convert: () => {
                void commands.convert(tasks)
                clearSelection()
              },
              remove: () => {
                void commands.remove(tasks)
                clearSelection()
              },
              openNote: (openInNewWindow) => {
                navigateNoteLink({ target: routeForPath(task.notePath), openInNewWindow })
              },
            })
          },
        })
        .catch((cause: unknown) => {
          operations.start('Opening task menu').fail(errorMessage(cause))
        })
    },
    [
      tasksByKey,
      getSelected,
      selectedTasks,
      clear,
      nativeMenu,
      today,
      commands,
      navigateNoteLink,
      operations,
    ],
  )
  useTaskKeyboard({
    selection,
    commands,
    tasksByKey,
    orderedTasks,
    query,
    setQuery,
    today,
    showCurrent: () => {
      if (!filters.current) {
        toggle('current')
      }
    },
    rootRef,
    scrollToKey,
    onToggleFilters: () => setFiltersOpen((open) => !open),
    onToggleSchedule: () => setScheduleOpen((open) => !open),
    onConvertToBullet,
  })

  const renderHeader = useCallback(
    (group: TaskGroup) => (
      <TaskGroupHeader
        group={group}
        today={today}
        onAdd={onAdd}
        onOpenNote={openNote}
        className="lg:px-12"
      />
    ),
    [today, onAdd, openNote],
  )
  const renderRow = useCallback(
    (row: TaskListRow) => {
      if (row.kind === 'breadcrumbs') {
        return (
          <TaskBreadcrumbs
            breadcrumbs={row.breadcrumbs}
            onSelect={() => select(row.tasks.map((task) => task.taskId))}
          />
        )
      }
      const { task } = row
      const selected = selectedTaskKeys.has(task.taskId)
      return (
        <TaskRow
          task={task}
          showSource={row.showSource}
          selected={selected}
          onSelect={clickSelect}
          onCheckboxToggle={onCheckboxToggle}
          editHandlers={task.taskId === editingTaskId ? editHandlers(task) : undefined}
          onOpenNote={openNote}
        />
      )
    },
    [
      select,
      selectedTaskKeys,
      editingTaskId,
      clickSelect,
      onCheckboxToggle,
      editHandlers,
      openNote,
    ],
  )

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
        {selectedCount > 0 ? (
          <TaskScheduleCalendar
            open={scheduleOpen}
            onOpenChange={setScheduleOpen}
            today={today}
            onSchedule={onSchedule}
          >
            <Button
              type="button"
              variant="ghost"
              aria-label={`Schedule ${selectedCount}`}
              className="window-drag-control text-xs text-text-muted"
            >
              <CalendarClock aria-hidden className="size-3.5" />
              Schedule
              <TaskToolbarCountBadge count={selectedCount} />
            </Button>
          </TaskScheduleCalendar>
        ) : null}
        {selectedCount > 0 ? (
          <Button
            type="button"
            variant="ghost"
            aria-label={`Convert to bullet ${selectedCount}`}
            onClick={onConvertToBullet}
            title="Drop the checkbox, keeping the line as a plain bullet — leaves the Tasks list"
            className="window-drag-control text-xs text-text-muted"
          >
            <List aria-hidden className="size-3.5" />
            Convert to bullet
            <TaskToolbarCountBadge count={selectedCount} />
          </Button>
        ) : null}
        {struck.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            aria-label={`Archive ${struck.length}`}
            onClick={() => commands.archive()}
            className="window-drag-control text-xs text-text-muted"
          >
            <Archive aria-hidden className="size-3.5" />
            Archive
            <TaskToolbarCountBadge count={struck.length} />
          </Button>
        ) : null}
        <TaskFiltersMenu
          filters={filters}
          toggle={toggle}
          open={filtersOpen}
          onOpenChange={setFiltersOpen}
        />
      </header>
      {/* The empty state waits for `ready`: with archived on, a graph with only
          completed tasks would flash "No tasks to show." while they load. */}
      {ready && groups.length === 0 ? (
        <p className="px-4 py-6 text-sm text-text-muted lg:px-12">
          {needle ? 'No matching tasks.' : 'No tasks to show.'}
        </p>
      ) : (
        <TaskList
          ref={listRef}
          className="min-h-0 flex-1 pb-8"
          groups={groups}
          ready={ready}
          rowHeight={TASK_ROW_HEIGHT}
          groupGap={GROUP_GAP}
          // The inline editor saves its draft and loses focus when it unmounts.
          keepMountedTaskId={editingTaskId}
          onContextMenu={onListContextMenu}
          renderHeader={renderHeader}
          renderRow={renderRow}
        />
      )}
    </div>
  )
}
