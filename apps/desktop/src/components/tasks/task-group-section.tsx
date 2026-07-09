import { Fragment, type MutableRefObject, type ReactElement } from 'react'
import { Plus } from 'lucide-react'
import { groupTaskContexts, type OpenTask, type TaskGroup } from '@reflect/core'
import { addTargetForGroup, taskGroupHeaderStyle } from '@/lib/tasks/task-group-presentation'
import type { InsertTaskTarget } from '@/lib/tasks/task-insert-target'
import { taskKey } from '@/lib/tasks/task-identity'
import type { TaskSelection } from '@/lib/tasks/use-task-selection'
import type { TaskRowEditHandlers } from '@/lib/tasks/use-task-row-handlers'
import { cn } from '@/lib/utils'
import { TaskBreadcrumbs } from './task-breadcrumbs'
import { TaskRow } from './task-row'

interface TaskGroupSectionProps {
  group: TaskGroup
  selection: TaskSelection
  /** The inline-editor callbacks for a row, built once by the screen. */
  editHandlers: (task: OpenTask) => TaskRowEditHandlers
  /** Whether a Tasks-view write is already in flight. */
  taskActionPending: boolean
  /** Complete/reopen the selected rows using the clicked task's next checkbox state. */
  onSelectionCheckboxToggle: (task: OpenTask) => void
  /** Today's ISO date — the Current group's "+ Add" targets today's daily. */
  today: string
  /** Add a task to this group and open its editor (the header's "+ Add", V1). */
  onAdd: (target: InsertTaskTarget) => void
  /** Holds the editing row's flush-then-convert trigger for the toolbar button. */
  convertControllerRef: MutableRefObject<(() => void) | null>
  onOpen: (notePath: string) => void
}

/**
 * One section of the Tasks view (V1 design): a sticky, colour-coded header — a
 * date bucket (Current/Overdue/Upcoming) or a note — over its task rows. The
 * header sticks to the top of the scroll container, so the next group's header
 * pushes the previous one up as you scroll. A note group's header opens the note.
 */
export function TaskGroupSection({
  group,
  selection,
  editHandlers,
  taskActionPending,
  onSelectionCheckboxToggle,
  today,
  onAdd,
  convertControllerRef,
  onOpen,
}: TaskGroupSectionProps): ReactElement {
  const showSource = group.kind !== 'note'
  const { notePath } = group
  const { icon, colorClass } = taskGroupHeaderStyle(group)
  const addTarget = addTargetForGroup(group, today)
  const contexts = groupTaskContexts(group.tasks)

  return (
    <section>
      <div className="sticky top-0 z-10 flex items-center gap-2 bg-surface-sunken px-4 py-1.5 lg:px-12">
        <h2 className={cn('flex min-w-0 items-center gap-2 text-sm font-medium', colorClass)}>
          {icon}
          {group.kind === 'note' && notePath !== null ? (
            <button
              type="button"
              onClick={() => onOpen(notePath)}
              className="truncate hover:underline focus-visible:underline focus-visible:outline-none"
            >
              {group.label}
            </button>
          ) : (
            <span className="truncate">{group.label}</span>
          )}
        </h2>
        {addTarget !== null ? (
          <button
            type="button"
            aria-label={`Add a task to ${group.kind === 'current' ? 'today' : group.label}`}
            onClick={() => onAdd(addTarget)}
            className="ml-auto flex flex-none items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-text-muted transition-colors hover:text-text focus-visible:text-text focus-visible:outline-none"
          >
            <Plus aria-hidden className="size-3.5" />
            Add
          </button>
        ) : null}
      </div>
      <ul className="flex flex-col py-1">
        {group.tasks.length === 0 ? (
          <li className="px-4 py-1.5 text-sm text-text-muted lg:px-12">No tasks</li>
        ) : (
          contexts.map((context) => {
            const firstTask = context.tasks[0]!
            return (
              <Fragment key={taskKey(firstTask)}>
                <TaskBreadcrumbs
                  breadcrumbs={context.breadcrumbs}
                  onSelect={() => selection.select(context.tasks.map(taskKey))}
                />
                {context.tasks.map((task) => {
                  const key = taskKey(task)
                  const selected = selection.isSelected(key)
                  return (
                    <TaskRow
                      key={key}
                      task={task}
                      showSource={showSource}
                      selected={selected}
                      editing={selection.isSoleSelected(key)}
                      taskActionPending={taskActionPending}
                      togglesSelection={selected && selection.selectedCount > 1}
                      onSelect={(event) => selection.clickSelect(key, event)}
                      onSelectionCheckboxToggle={() => onSelectionCheckboxToggle(task)}
                      {...editHandlers(task)}
                      convertControllerRef={convertControllerRef}
                      onOpen={onOpen}
                    />
                  )
                })}
              </Fragment>
            )
          })
        )}
      </ul>
    </section>
  )
}
