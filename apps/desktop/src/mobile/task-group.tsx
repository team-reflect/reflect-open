import { type ReactElement } from 'react'
import { Plus } from 'lucide-react'
import type { OpenTask, TaskGroup } from '@reflect/core'
import { addTargetForGroup, taskGroupHeaderStyle } from '@/lib/tasks/task-group-presentation'
import { taskKey } from '@/lib/tasks/task-identity'
import type { InsertTaskTarget } from '@/lib/tasks/task-insert-target'
import { cn } from '@/lib/utils'
import { hapticImpactLight } from '@/mobile/haptics'
import { MobileTaskRow } from '@/mobile/task-row'

interface MobileTaskGroupProps {
  group: TaskGroup
  /** Today's ISO date — the Current group's "+" adds to today's daily. */
  today: string
  /** Add a task to this group and open its quick-edit sheet. */
  onAdd: (target: InsertTaskTarget) => void
  /** Open the quick-edit sheet for a tapped row. */
  onEdit: (task: OpenTask) => void
  /** Open a note group's source note from its header. */
  onOpen: (notePath: string) => void
}

/**
 * One section of the mobile Tasks tab: a sticky, colour-coded header — a date
 * bucket (Current/Overdue/Upcoming) or a note — with a task count (V1 mobile
 * showed counts on its groups) over the rows. A note group's header opens the
 * note; Current and note groups grow a "+" that adds a task there and opens
 * its quick-edit sheet.
 */
export function MobileTaskGroup({
  group,
  today,
  onAdd,
  onEdit,
  onOpen,
}: MobileTaskGroupProps): ReactElement {
  const showSource = group.kind !== 'note'
  const { notePath } = group
  const { icon, colorClass } = taskGroupHeaderStyle(group)
  const addTarget = addTargetForGroup(group, today)

  return (
    <section>
      <div className="sticky top-0 z-10 flex items-center gap-2 bg-surface-sunken px-4 py-1.5">
        <h2 className={cn('flex min-w-0 items-center gap-2 text-sm font-medium', colorClass)}>
          {icon}
          {/* The pin icon alone is invisible to screen readers (aria-hidden). */}
          {group.kind === 'note' && group.tasks[0]?.isPinned ? (
            <span className="sr-only">Pinned:</span>
          ) : null}
          {group.kind === 'note' && notePath !== null ? (
            <button
              type="button"
              onClick={() => {
                hapticImpactLight()
                onOpen(notePath)
              }}
              className="truncate"
            >
              {group.label}
            </button>
          ) : (
            <span className="truncate">{group.label}</span>
          )}
          <span className="text-xs font-normal text-text-muted">{group.tasks.length}</span>
        </h2>
        {addTarget !== null ? (
          <button
            type="button"
            aria-label={`Add a task to ${group.kind === 'current' ? 'today' : group.label}`}
            onClick={() => onAdd(addTarget)}
            className="-my-1 ml-auto flex size-8 flex-none items-center justify-center text-text-muted"
          >
            <Plus aria-hidden className="size-4" />
          </button>
        ) : null}
      </div>
      <ul className="flex flex-col">
        {group.tasks.map((task) => (
          <MobileTaskRow key={taskKey(task)} task={task} showSource={showSource} onEdit={onEdit} />
        ))}
      </ul>
    </section>
  )
}
