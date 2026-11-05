import type { ReactElement } from 'react'
import { Plus } from 'lucide-react'
import type { InsertTaskTarget, TaskGroup } from '@reflect/core'
import { addTargetForGroup, taskGroupHeaderStyle } from '@/lib/tasks/task-group-presentation.tsx'
import { cn } from '@/lib/utils.ts'
import type { ModClickEvent } from '@/hooks/use-note-link-navigation.ts'

/**
 * Height (px) of the header bar (`h-8`), which covers the rows when stuck.
 */
export const TASK_GROUP_HEADER_HEIGHT = 32

interface TaskGroupHeaderProps {
  group: TaskGroup
  /**
   * Today's ISO date — the Current group's "+ Add" targets today's daily.
   */
  today: string
  /**
   * Add a task to this group and open its editor (the header's "+ Add", V1).
   */
  onAdd: (target: InsertTaskTarget) => void
  onOpen: (notePath: string, event?: ModClickEvent) => void
}

/**
 * The header of one Tasks group (V1 design): a colour-coded date bucket
 * (Current/Overdue/Upcoming) or note. A note group's header opens the note.
 * The bar is a fixed height, so the next header fully covers the stuck one.
 */
export function TaskGroupHeader({
  group,
  today,
  onAdd,
  onOpen,
}: TaskGroupHeaderProps): ReactElement {
  const { notePath } = group
  const { icon, colorClass } = taskGroupHeaderStyle(group)
  const addTarget = addTargetForGroup(group, today)

  return (
    // `pb-1` spaces the first row from the bar.
    <div className="pb-1">
      <div className="flex h-8 items-center gap-2 bg-surface-sunken px-4 lg:px-12">
        <h2 className={cn('flex min-w-0 items-center gap-2 text-sm font-medium', colorClass)}>
          {icon}
          {group.kind === 'note' && notePath !== null ? (
            <button
              type="button"
              onClick={(event) => onOpen(notePath, event)}
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
    </div>
  )
}
