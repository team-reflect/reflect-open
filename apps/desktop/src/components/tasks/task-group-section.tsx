import type { ReactElement } from 'react'
import { AlarmClock, Calendar, FileText, Pin, Star } from 'lucide-react'
import type { TaskGroup } from '@reflect/core'
import { taskKey } from '@/lib/tasks/task-identity'
import type { TaskActions } from '@/lib/tasks/use-task-actions'
import type { TaskSelection } from '@/lib/tasks/use-task-selection'
import { cn } from '@/lib/utils'
import { TaskRow } from './task-row'

interface TaskGroupSectionProps {
  group: TaskGroup
  selection: TaskSelection
  actions: TaskActions
  onOpen: (notePath: string) => void
}

/** The icon + accent colour for a group's sticky header, V1's per-bucket styling. */
function headerStyle(group: TaskGroup): { icon: ReactElement; colorClass: string } {
  switch (group.kind) {
    case 'current':
      return { icon: <Star aria-hidden className="size-4" />, colorClass: 'text-amber-500' }
    case 'overdue':
      return { icon: <AlarmClock aria-hidden className="size-4" />, colorClass: 'text-red-500' }
    case 'upcoming':
      return { icon: <Calendar aria-hidden className="size-4" />, colorClass: 'text-green-600' }
    case 'note':
      return group.tasks[0]?.isPinned
        ? { icon: <Pin aria-hidden className="size-4" />, colorClass: 'text-accent' }
        : { icon: <FileText aria-hidden className="size-4" />, colorClass: 'text-text-secondary' }
  }
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
  actions,
  onOpen,
}: TaskGroupSectionProps): ReactElement {
  const showSource = group.kind !== 'note'
  const { notePath } = group
  const { icon, colorClass } = headerStyle(group)

  return (
    <section>
      <h2
        className={cn(
          'sticky top-0 z-10 flex items-center gap-2 bg-surface-sunken px-4 py-1.5 text-sm font-medium lg:px-12',
          colorClass,
        )}
      >
        {icon}
        {group.kind === 'note' && notePath !== null ? (
          <button
            type="button"
            onClick={() => onOpen(notePath)}
            className="hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {group.label}
          </button>
        ) : (
          <span>{group.label}</span>
        )}
      </h2>
      <ul className="px-4 py-1 lg:px-12">
        {group.tasks.map((task) => {
          const key = taskKey(task)
          return (
            <TaskRow
              key={key}
              task={task}
              showSource={showSource}
              selected={selection.isSelected(key)}
              editing={selection.isSoleSelected(key)}
              onSelect={(event) => selection.clickSelect(key, event)}
              onEditCommit={(content) => {
                actions.edit(task, content)
                selection.clear()
              }}
              onEditDelete={() => {
                actions.remove([task])
                selection.clear()
              }}
              onEditCancel={() => selection.clear()}
              onEditComplete={(content) => {
                if (content === null) {
                  actions.complete([task])
                } else {
                  actions.editAndComplete(task, content)
                }
                selection.clear()
              }}
              // Unmount flush: the selection has already moved, so persist the
              // edit but leave the (new) selection alone.
              onEditFlush={(content) => actions.edit(task, content)}
              onOpen={onOpen}
            />
          )
        })}
      </ul>
    </section>
  )
}
