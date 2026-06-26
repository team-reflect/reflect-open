import { memo, useCallback, type CSSProperties, type MouseEvent, type ReactElement } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useQueryClient } from '@tanstack/react-query'
import { errorMessage } from '@reflect/core'
import type { PinnedNote } from '@reflect/core'
import {
  invalidatePinnedNotesCache,
  restorePinnedNotesCache,
  updatePinnedNotesCache,
} from '@/lib/notes/pinned-notes-cache'
import { formatDayLabel } from '@/lib/dates'
import { openPinnedNoteContextMenu } from '@/lib/native-menu/pinned-note-context-menu'
import { unpinNote } from '@/lib/note-pin'
import { startOperation } from '@/lib/operations'
import { useGraph } from '@/providers/graph-provider'
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
  const { graph } = useGraph()
  const queryClient = useQueryClient()
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
  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      event.preventDefault()
      event.stopPropagation()
      if (graph === null) {
        return
      }
      void openPinnedNoteContextMenu(() => {
        const snapshot = updatePinnedNotesCache(queryClient, graph.root, (current) =>
          current?.filter((pinnedNote) => pinnedNote.path !== note.path),
        )

        void unpinNote(note.path, graph.generation).catch((cause: unknown) => {
          restorePinnedNotesCache(queryClient, snapshot)
          invalidatePinnedNotesCache(queryClient, snapshot)
          startOperation('Unpinning note').fail(errorMessage(cause))
        })
      }).catch((cause: unknown) => {
        startOperation('Opening note menu').fail(errorMessage(cause))
      })
    },
    [graph, note.path, queryClient],
  )

  return (
    <li className="-mx-2.5">
      <button
        ref={setNodeRef}
        type="button"
        style={style}
        onClick={() => navigate(target)}
        onContextMenu={handleContextMenu}
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
