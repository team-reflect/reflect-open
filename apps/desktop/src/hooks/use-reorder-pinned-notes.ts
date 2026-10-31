import { useCoreServices } from '@/services/services-provider.tsx'
import { arrayMove } from '@dnd-kit/sortable'
import { updatePinOrder, type PinnedNote } from '@reflect/core'
import { useCallback } from 'react'

export function useReorderPinnedNotes(
  pinned: readonly PinnedNote[],
): (activePath: string, overPath: string) => void {
  const { noteActions } = useCoreServices()

  return useCallback(
    (activePath: string, overPath: string): void => {
      const activeIndex = pinned.findIndex((note) => note.path === activePath)
      const overIndex = pinned.findIndex((note) => note.path === overPath)
      if (activeIndex === -1 || overIndex === -1 || activeIndex === overIndex) {
        return
      }

      // Move the note in the array.
      const moved: PinnedNote[] = arrayMove([...pinned], activeIndex, overIndex)

      // Update `note.pinnedOrder` in the moved note to maintain the correct order.
      const renumbered: PinnedNote[] = updatePinOrder(moved, activePath)

      // All notes that changed `note.pinnedOrder`
      const updated = renumbered.filter((a, index) => {
        const b = moved[index]
        return a && b && a.pinnedOrder !== b.pinnedOrder
      })

      // A failed write drops its overlay, so the shelf shows the index again.
      noteActions.reorderPinned(updated).catch(() => {})
    },
    [noteActions, pinned],
  )
}
