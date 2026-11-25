import { useDeferredValue, useMemo, useRef, useState, type ReactElement } from 'react'
import { CircleCheck } from 'lucide-react'
import {
  todaysDailyTarget,
  WritableStore,
  type InsertTaskTarget,
  type OpenTask,
} from '@reflect/core'
import { Button } from '@/components/ui/button.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { TaskBreadcrumbs } from '@/components/tasks/task-breadcrumbs.tsx'
import { TaskGroupHeader } from '@/components/tasks/task-group-header.tsx'
import { TaskList } from '@/components/tasks/task-list.tsx'
import { useTaskFilters } from '@/lib/tasks/task-filters.ts'
import { useVisibleTaskGroups } from '@/lib/tasks/use-visible-task-groups.ts'
import { useToday } from '@/lib/use-today.ts'
import { hapticImpactLight } from '@/mobile/haptics.ts'
import { useMobileServices } from '@/mobile/mobile-services.ts'
import { MobileTaskEditSheet } from '@/mobile/task-edit-sheet.tsx'
import { TaskFiltersDrawer } from '@/mobile/task-filters-drawer.tsx'
import { MOBILE_TASK_ROW_HEIGHT, MobileTaskRow } from '@/mobile/task-row.tsx'
import { ChromeTopBar } from '@/mobile/chrome/chrome-top-bar.tsx'
import type { Focusable } from '@/mobile/chrome/screen-chrome.ts'
import { useArrivalFocus } from '@/mobile/use-arrival-focus.ts'
import { useScrollRestoration } from '@/lib/use-scroll-restoration.ts'
import { useGraphInfo } from '@/providers/graph-provider.tsx'
import { routeForPath } from '@reflect/app'
import { useRouterState, useRouterActions } from '@/routing/router.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

interface MobileTasksProps {
  /**
   * The live search text — lifted to the shell so it survives navigation.
   */
  query: string
  onQueryChange: (query: string) => void
}

/**
 * The Tasks tab (V1 mobile's third tab over Plan 18's shipped data layer): every
 * open task across the graph in desktop's exact groups — Current / Overdue /
 * Upcoming, then per-note — via the same task rows, grouping
 * ({@link composeVisibleTaskGroups}) and task commands the desktop view uses;
 * this screen adds only the touch surface. Task taps, toggles, adds, filters, scheduling, and archival
 * get light haptics; tapping a row opens the quick-edit sheet (edit / schedule /
 * complete / convert / open note) instead of desktop's multi-select; the filter
 * sheet carries desktop's bucket toggles and "Show archived". Swiping a row
 * left reveals the note list's two actions, open the source note and delete the
 * task; one row's actions show at a time and scrolling closes them. Completing
 * keeps the row struck (V1's middle state) until Archive hides this session's
 * completed tasks.
 */
export function MobileTasks({ query, onQueryChange }: MobileTasksProps): ReactElement {
  const { haptics } = useMobileServices()
  const { tasks: taskService } = useCoreServices()
  const { commands } = taskService
  const graph = useGraphInfo()
  const { arrivalSeq, arrivalFocusEditor } = useRouterState()
  const { navigate } = useRouterActions()
  const today = useToday()
  const { filters, toggle } = useTaskFilters()
  const searchInputRef = useRef<Focusable>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  // The one row whose swipe actions are showing (its `taskId`), across all groups.
  const [revealedRow] = useState(() => new WritableStore<string | null>(null))
  // The sheet's task sticks around after close so the exit animation has
  // content; `sheetOpen` alone drives visibility.
  const [editingTask, setEditingTask] = useState<OpenTask | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  // Whether the current sheet visit should open with the editor focused
  // (keyboard up) — set per visit: true for "+"-added tasks, false for row taps.
  const [autoFocusEditor, setAutoFocusEditor] = useState(false)
  const enabled = graph !== null

  // The Tasks-tab double-tap lands in the tab's capture surface: its live
  // search filter, selected so a replacement query can start immediately.
  useArrivalFocus({
    arrivalSeq,
    arrivalFocusEditor,
    target: searchInputRef,
    selectText: true,
  })

  // Defer the needle like the All tab defers its query: fast typing coalesces
  // while the input stays live. A cleared query applies immediately — the "+"
  // add clears it so the new row is visible, and a stale deferred needle must
  // not keep hiding that row while it catches up.
  const deferredQuery = useDeferredValue(query)
  const needle = (query === '' ? '' : deferredQuery).trim().toLowerCase()
  const { groups, ready, struck, resetKey } = useVisibleTaskGroups({ needle, filters, today })

  // The task list scroller renders only while there are rows to show.
  const listRef = useRef<HTMLDivElement>(null)
  const { onScroll } = useScrollRestoration(listRef, groups.length > 0)

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
    const key = editingTask.taskId
    return groups.flatMap((group) => group.tasks).find((row) => row.taskId === key) ?? editingTask
  }, [groups, editingTask])

  const editTask = (task: OpenTask, options?: { autoFocus?: boolean; haptic?: boolean }): void => {
    if (options?.haptic !== false) {
      hapticImpactLight(haptics)
    }
    setAutoFocusEditor(options?.autoFocus === true)
    setEditingTask(task)
    setSheetOpen(true)
  }

  // The group headers' "+" (V1): drop any search filter so the new row is
  // visible, then open its quick-edit sheet with the editor focused.
  const onAdd = (target: InsertTaskTarget): void => {
    hapticImpactLight(haptics)
    onQueryChange('')
    editTask(commands.add(target), { autoFocus: true, haptic: false })
  }

  const archiveCompleted = (): void => {
    hapticImpactLight(haptics)
    commands.archive()
  }

  return (
    <div className="flex h-full w-full flex-col pt-safe">
      <ChromeTopBar
        plus={{ kind: 'action', label: 'New task', onTap: () => onAdd(todaysDailyTarget(today)) }}
        search={{
          value: query,
          placeholder: 'Search tasks…',
          label: 'Search tasks',
          onChange: onQueryChange,
          ref: searchInputRef,
        }}
        trailing={[
          ...(struck.length > 0
            ? [
                {
                  id: 'archive',
                  title: `Archive ${struck.length} completed`,
                  icon: 'archive',
                } as const,
              ]
            : []),
          { id: 'filters', title: 'Task filters', icon: 'filters' },
        ]}
        onAction={(id) => {
          if (id === 'archive') {
            archiveCompleted()
          } else if (id === 'filters') {
            hapticImpactLight(haptics)
            setFiltersOpen(true)
          }
        }}
      />
      {enabled && !ready && groups.length === 0 ? (
        // Loading only gates what would otherwise be a false empty state: with
        // archived flipping on, the open groups keep showing while the
        // completed history loads (desktop likewise gates only the message).
        <div className="flex flex-1 items-center justify-center px-safe" aria-label="Loading tasks">
          <Spinner className="size-5 text-text-muted" />
        </div>
      ) : groups.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-safe text-text-muted">
          <CircleCheck className="size-6" />
          <p className="text-sm">{needle ? 'No matching tasks' : 'No tasks to show'}</p>
          {needle === '' ? (
            <Button variant="outline" onClick={() => onAdd(todaysDailyTarget(today))}>
              Add a task
            </Button>
          ) : null}
        </div>
      ) : (
        <div
          // A stacking context, so WebKit composites the sticky headers and row
          // surfaces inside this scroller, below the iOS scroll indicator.
          className="isolate min-h-0 flex-1 overflow-y-auto px-safe pb-chrome-safe-offset-24"
          ref={listRef}
          onScroll={(event) => {
            revealedRow.set(null)
            onScroll(event)
          }}
        >
          <TaskList
            scrollRef={listRef}
            groups={groups}
            resetKey={resetKey}
            rowHeight={MOBILE_TASK_ROW_HEIGHT}
            renderHeader={(group) => (
              <TaskGroupHeader
                group={group}
                today={today}
                onAdd={onAdd}
                onOpen={(path) => {
                  hapticImpactLight(haptics)
                  navigate(routeForPath(path))
                }}
              />
            )}
            renderRow={(row) => {
              if (row.kind === 'breadcrumbs') {
                return <TaskBreadcrumbs breadcrumbs={row.labels} className="px-4 pb-1 pt-3" />
              }
              const { task } = row
              return (
                <MobileTaskRow
                  task={task}
                  showSource={row.showSource}
                  onEdit={editTask}
                  onToggle={() => void commands.toggle([task])}
                  revealedRow={revealedRow}
                  onOpenNote={() => navigate(routeForPath(task.notePath))}
                  onDelete={() => void commands.remove([task])}
                />
              )
            }}
          />
        </div>
      )}
      {liveEditingTask !== null ? (
        <MobileTaskEditSheet
          key={liveEditingTask.taskId}
          task={liveEditingTask}
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          today={today}
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
