import type { ReactElement } from 'react'
import { Plus } from 'lucide-react'
import type { InsertTaskTarget, TaskGroup } from '@reflect/core'
import { addTargetForGroup, taskGroupHeaderStyle } from '@/lib/tasks/task-group-presentation.tsx'
import { cn } from '@/lib/utils.ts'
import { hapticImpactLight } from '@/mobile/haptics.ts'
import { useMobileServices } from '@/mobile/mobile-services.ts'

interface MobileTaskGroupHeaderProps {
  group: TaskGroup
  /**
   * Today's ISO date — the Current group's "+" adds to today's daily.
   */
  today: string
  /**
   * Add a task to this group and open its quick-edit sheet.
   */
  onAdd: (target: InsertTaskTarget) => void
  /**
   * Open a note group's source note.
   */
  onOpen: (notePath: string) => void
}

/**
 * The header of one mobile Tasks group: a colour-coded date bucket
 * (Current/Overdue/Upcoming) or note, with a task count (V1 mobile showed
 * counts on its groups). A note group's header opens the note; Current and
 * note groups grow a "+" that adds a task there and opens its quick-edit sheet.
 * Fixed at 32px, so the next header fully covers the stuck one.
 */
export function MobileTaskGroupHeader({
  group,
  today,
  onAdd,
  onOpen,
}: MobileTaskGroupHeaderProps): ReactElement {
  const { haptics } = useMobileServices()
  const { notePath } = group
  const { icon, colorClass } = taskGroupHeaderStyle(group)
  const addTarget = addTargetForGroup(group, today)

  return (
    // `bg-surface` is opaque, so rows do not show through the translucent
    // dark-mode `bg-surface-sunken`.
    <div className="bg-surface">
      <div className="flex h-8 items-center gap-2 bg-surface-sunken px-4">
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
                hapticImpactLight(haptics)
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
            className="ml-auto flex size-8 flex-none items-center justify-center text-text-muted"
          >
            <Plus aria-hidden className="size-4" />
          </button>
        ) : null}
      </div>
    </div>
  )
}
