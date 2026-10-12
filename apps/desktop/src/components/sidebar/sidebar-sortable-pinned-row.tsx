import { memo, useCallback, type CSSProperties, type MouseEvent, type ReactElement } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useQueryClient } from '@tanstack/react-query'
import { errorMessage } from '@reflect/core'
import type { PinnedNote } from '@reflect/core'
import { unpinNote } from '@/lib/note-pin.ts'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import { openNativeContextMenu } from '@/lib/native-menu/context-menu.ts'
import { startOperation } from '@/lib/operations.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { routeForPath, routesEqual } from '@/routing/route.ts'
import { useRouter } from '@/routing/router.tsx'
import { SidebarPinnedRowPreview } from './sidebar-pinned-row-preview.tsx'
import { isModEvent } from '@meowdown/core'
import { useNoteLabel } from '@/hooks/use-note-label.ts'

interface SidebarSortablePinnedRowProps {
  note: PinnedNote
}

export const SidebarSortablePinnedRow = memo(function SidebarSortablePinnedRow({
  note,
}: SidebarSortablePinnedRowProps): ReactElement {
  const { route } = useRouter()
  const navigateNoteLink = useNoteLinkNavigation()
  const noteLabel = useNoteLabel()
  const { graph } = useGraph()
  const queryClient = useQueryClient()
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
      if (graph === null) {
        return
      }
      void openNativeContextMenu({
        items: [
          {
            text: 'Unpin Note',
            action: () => {
              void unpinNote({
                queryClient,
                root: graph.root,
                generation: graph.generation,
                path: note.path,
              })
            },
          },
        ],
      }).catch((cause: unknown) => {
        startOperation('Opening note menu').fail(errorMessage(cause))
      })
    },
    [graph, note, queryClient],
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
