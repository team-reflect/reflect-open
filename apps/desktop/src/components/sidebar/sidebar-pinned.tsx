import { useCallback, useState, type ReactElement } from 'react'
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { usePinnedNotes } from '@/hooks/use-pinned-notes.ts'
import { useReorderPinnedNotes } from '@/hooks/use-reorder-pinned-notes.ts'
import { routeForPath, routesEqual } from '@reflect/app'
import { useRouter } from '@/routing/router.tsx'
import { SidebarPinnedRowPreview } from './sidebar-pinned-row-preview.tsx'
import { SidebarSortablePinnedRow } from './sidebar-sortable-pinned-row.tsx'
import { useNoteLabel } from '@/hooks/use-note-label.ts'

/**
 * The sidebar's Pinned section (the Mac app's "Pinned notes" shelf):
 * every pinned note, shelf-ordered, above the Recents feed. Hidden entirely
 * while nothing is pinned — an empty shelf is sidebar noise, not an affordance.
 */
export function SidebarPinned(): ReactElement | null {
  const pinned = usePinnedNotes()
  const reorder = useReorderPinnedNotes(pinned)
  const noteLabel = useNoteLabel()
  const { route } = useRouter()
  const [activePath, setActivePath] = useState<string | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const activeNote =
    activePath === null ? undefined : pinned.find((note) => note.path === activePath)
  const handleDragStart = useCallback((event: DragStartEvent): void => {
    setActivePath(String(event.active.id))
  }, [])
  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
      const activeId = String(event.active.id)
      setActivePath(null)
      if (event.over === null) {
        return
      }
      reorder(activeId, String(event.over.id))
    },
    [reorder],
  )
  const handleDragCancel = useCallback((): void => {
    setActivePath(null)
  }, [])

  if (pinned.length === 0) {
    return null
  }

  return (
    // px-6.5 starts the section's text at the nav rows' icon edge (the nav's
    // px-4 plus each row's px-2.5).
    <section aria-label="Pinned notes" className="px-6.5">
      <h2 className="pt-4 text-2xs font-medium leading-5 tracking-wide text-text-muted">
        Pinned notes
      </h2>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext
          items={pinned.map((note) => note.path)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="mt-2 flex flex-col space-y-1">
            {pinned.map((note) => (
              <SidebarSortablePinnedRow key={note.path} note={note} />
            ))}
          </ul>
        </SortableContext>
        <DragOverlay>
          {activeNote === undefined ? null : (
            <SidebarPinnedRowPreview
              active={routesEqual(route, routeForPath(activeNote.path))}
              overlay
              label={noteLabel(activeNote)}
            />
          )}
        </DragOverlay>
      </DndContext>
    </section>
  )
}
