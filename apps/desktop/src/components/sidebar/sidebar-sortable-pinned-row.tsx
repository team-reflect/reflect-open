import { memo, type CSSProperties, type ReactElement } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { PinnedNote } from '@reflect/core'
import { formatDayLabel } from '@/lib/dates'
import { useSettings } from '@/providers/settings-provider'
import { routeForPath, routesEqual } from '@/routing/route'
import { useRouter } from '@/routing/router'
import { SidebarPinnedRowPreview } from './sidebar-pinned-row-preview'

interface SidebarSortablePinnedRowProps {
  note: PinnedNote
}

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
    isDragging,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: note.path })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <li className="-mx-2.5">
      <button
        ref={setNodeRef}
        type="button"
        style={style}
        onClick={() => navigate(target)}
        aria-current={active ? 'page' : undefined}
        className="block w-full"
        {...listeners}
      >
        <SidebarPinnedRowPreview
          active={active}
          label={label}
          placeholder={isDragging}
        />
      </button>
    </li>
  )
})
