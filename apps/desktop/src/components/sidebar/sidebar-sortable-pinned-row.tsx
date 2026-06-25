import { memo, type CSSProperties, type ReactElement } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { PinnedNote } from '@reflect/core'
import { GripVertical } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDayLabel } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { useSettings } from '@/providers/settings-provider'
import { routeForPath, routesEqual } from '@/routing/route'
import { useRouter } from '@/routing/router'

interface SidebarSortablePinnedRowProps {
  note: PinnedNote
}

/**
 * One sortable row in the pinned shelf. The title remains the navigation
 * button; the grip is the only drag activator, keeping click behavior stable.
 */
export const SidebarSortablePinnedRow = memo(function SidebarSortablePinnedRow({
  note,
}: SidebarSortablePinnedRowProps): ReactElement {
  const { route, navigate } = useRouter()
  const { settings } = useSettings()
  const target = routeForPath(note.path)
  const active = routesEqual(route, target)
  const label =
    note.dailyDate !== null ? formatDayLabel(note.dailyDate, settings.dateFormat) : note.title
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: note.path })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <li ref={setNodeRef} style={style} className={cn('-mx-2.5', isDragging && 'z-10')}>
      <div
        className={cn(
          'group flex w-full items-center rounded-md leading-5 transition-colors duration-100',
          active
            ? 'bg-surface-hover text-text dark:bg-transparent dark:text-accent'
            : 'text-text-secondary hover:bg-surface-hover hover:text-text',
          isDragging && 'bg-surface-hover text-text opacity-70',
        )}
      >
        <button
          type="button"
          onClick={() => navigate(target)}
          aria-current={active ? 'page' : undefined}
          className="min-w-0 flex-1 py-1 pl-2.5 pr-1 text-left"
        >
          <span className="block truncate text-xs font-medium">{label}</span>
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              ref={setActivatorNodeRef}
              type="button"
              aria-label={`Reorder ${label}`}
              className={cn(
                'mr-1 flex size-5 shrink-0 touch-none items-center justify-center rounded text-text-muted',
                'opacity-0 transition-opacity duration-100 hover:text-text group-hover:opacity-100',
                'focus:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                isDragging && 'opacity-100',
              )}
              {...attributes}
              {...listeners}
            >
              <GripVertical aria-hidden strokeWidth={1.75} className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Reorder</TooltipContent>
        </Tooltip>
      </div>
    </li>
  )
})
