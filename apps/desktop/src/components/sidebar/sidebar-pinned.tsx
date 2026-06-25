import { useCallback, useMemo, type ReactElement } from 'react'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { usePinnedNotes } from '@/hooks/use-pinned-notes'
import { useReorderPinnedNotes } from '@/hooks/use-reorder-pinned-notes'
import { SidebarSortablePinnedRow } from './sidebar-sortable-pinned-row'

/**
 * The sidebar's Pinned section (the original app's "Pinned notes" shelf):
 * every note carrying `pinned: true` frontmatter, title-ordered, above the
 * Recents feed. Hidden entirely while nothing is pinned — an empty shelf is
 * sidebar noise, not an affordance.
 */
export function SidebarPinned(): ReactElement | null {
  const pinned = usePinnedNotes()
  const reorder = useReorderPinnedNotes(pinned)
  const pinnedPaths = useMemo(() => pinned.map((note) => note.path), [pinned])
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
      if (event.over === null) {
        return
      }
      reorder(String(event.active.id), String(event.over.id))
    },
    [reorder],
  )

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
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={pinnedPaths} strategy={verticalListSortingStrategy}>
          <ul className="mt-2 flex flex-col space-y-1">
            {pinned.map((note) => (
              <SidebarSortablePinnedRow key={note.path} note={note} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </section>
  )
}
