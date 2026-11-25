import type { ReactElement } from 'react'
import { Plus } from 'lucide-react'
import type { InsertTaskTarget, TaskGroup } from '@reflect/core'
import type { ModClickEvent } from '@/hooks/use-note-link-navigation.ts'
import { addTargetForGroup, taskGroupHeaderStyle } from '@/lib/tasks/task-group-presentation.tsx'
import { cn } from '@/lib/utils.ts'

interface TaskGroupHeaderProps {
  group: TaskGroup
  /**
   * Today's ISO date: the Current group's "Add" targets today's daily.
   */
  today: string
  /**
   * Add a task to this group.
   */
  onAdd: (target: InsertTaskTarget) => void
  /**
   * Open a note group's source note.
   */
  onOpenNote: (notePath: string, event: ModClickEvent) => void
  /**
   * Classes for the header row, e.g. its horizontal padding.
   */
  className?: string | undefined
}

/**
 * The header of one group in a Tasks list, colour-coded: a date bucket
 * (Current/Overdue/Upcoming) or a note, with its task count. A note group's
 * header opens the note. Current and note groups have an "Add" button, with
 * its label in a wide header only. It fills the height of its parent.
 */
export function TaskGroupHeader({
  group,
  today,
  onAdd,
  onOpenNote,
  className,
}: TaskGroupHeaderProps): ReactElement {
  const { notePath } = group
  const { icon, colorClass } = taskGroupHeaderStyle(group)
  const addTarget = addTargetForGroup(group, today)

  return (
    // `bg-surface-canvas` is opaque, so rows do not show through the translucent
    // dark-mode `bg-surface-sunken`.
    <div className="@container h-full bg-surface-canvas">
      <div className={cn('flex h-full items-center gap-2 bg-surface-sunken px-4', className)}>
        <h2 className={cn('flex min-w-0 items-center gap-2 text-sm font-medium', colorClass)}>
          {icon}
          {/* The pin icon alone is invisible to screen readers (aria-hidden). */}
          {group.kind === 'note' && group.tasks[0]?.isPinned ? (
            <span className="sr-only">Pinned:</span>
          ) : null}
          {group.kind === 'note' && notePath !== null ? (
            <button
              type="button"
              onClick={(event) => onOpenNote(notePath, event)}
              className="truncate hover:underline focus-visible:underline focus-visible:outline-none"
            >
              {group.label}
            </button>
          ) : (
            <span className="truncate">{group.label}</span>
          )}
        </h2>
        <span className="text-xs text-text-muted">{group.tasks.length}</span>
        {addTarget !== null ? (
          <button
            type="button"
            aria-label={`Add a task to ${group.kind === 'current' ? 'today' : group.label}`}
            onClick={() => onAdd(addTarget)}
            className="ml-auto flex h-full -mr-4 min-w-11 @lg:mr-0 flex-none items-center justify-center gap-1 text-xs font-medium text-text-muted transition-colors hover:text-text focus-visible:text-text focus-visible:outline-none"
          >
            <Plus aria-hidden className="size-4" />
            {/* The label shows only where the header is wide enough for it. */}
            <span className="hidden @lg:inline">Add</span>
          </button>
        ) : null}
      </div>
    </div>
  )
}
