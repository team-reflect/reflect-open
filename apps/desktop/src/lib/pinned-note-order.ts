import type { PinnedNote } from '@reflect/core'

/**
 * Move one pinned note before/after another in the current rendered shelf.
 * Returns `null` when the drag does not describe a real reorder.
 */
export function movePinnedNote(
  notes: readonly PinnedNote[],
  activePath: string,
  overPath: string,
): PinnedNote[] | null {
  const activeIndex = notes.findIndex((note) => note.path === activePath)
  const overIndex = notes.findIndex((note) => note.path === overPath)

  if (activeIndex === -1 || overIndex === -1 || activeIndex === overIndex) {
    return null
  }

  const reordered = [...notes]
  const [activeNote] = reordered.splice(activeIndex, 1)
  if (activeNote === undefined) {
    return null
  }
  reordered.splice(overIndex, 0, activeNote)
  return reordered
}
