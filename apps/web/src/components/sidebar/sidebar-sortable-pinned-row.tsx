import type { PinnedNoteRow } from '@reflect/types'
import { memo, useCallback, type CSSProperties, type MouseEvent, type ReactElement } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import { routeForPath, routesEqual } from '@reflect/app'
import { useRouterState } from '@/routing/router.tsx'
import { useOpenNoteMenu } from '@/lib/notes/use-open-note-menu.ts'
import { SidebarPinnedRowPreview } from './sidebar-pinned-row-preview.tsx'
import { isModEvent } from '@meowdown/core'
import { useNoteLabel } from '@/hooks/use-note-label.ts'

interface SidebarSortablePinnedRowProps {
  note: PinnedNoteRow
}

export const SidebarSortablePinnedRow = memo(function SidebarSortablePinnedRow({
  note,
}: SidebarSortablePinnedRowProps): ReactElement {
  const { route } = useRouterState()
  const navigateNoteLink = useNoteLinkNavigation()
  const noteLabel = useNoteLabel()
  const openNoteMenu = useOpenNoteMenu()
  const target = routeForPath(note.path)
  const active = routesEqual(route, target)
  const label = noteLabel(note)
  const { isDragging, listeners, setNodeRef, transform, transition } = useSortable({
    id: note.path,
  })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }
  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      event.preventDefault()
      event.stopPropagation()
      openNoteMenu({ surface: 'sidebar', notes: [{ path: note.path, isPinned: true }] })
    },
    [openNoteMenu, note.path],
  )

  return (
    <li className="-mx-2.5">
      <button
        ref={setNodeRef}
        type="button"
        style={style}
        onClick={(event) => navigateNoteLink({ target, openInNewWindow: isModEvent(event) })}
        onContextMenu={handleContextMenu}
        aria-current={active ? 'page' : undefined}
        className="block w-full"
        {...listeners}
      >
        <SidebarPinnedRowPreview active={active} label={label} placeholder={isDragging} />
      </button>
    </li>
  )
})
