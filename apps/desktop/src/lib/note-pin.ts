import { isPinned, parseNote, type PinnedNote } from '@reflect/core'
import { clearNoteRowOverlay, setNoteRowOverlay } from '@/hooks/note-row-overlay'
import { commitNoteFrontmatter, readNoteSource } from '@/lib/note-frontmatter'

/**
 * Toggle a note's `pinned` frontmatter flag. Markdown is the source of truth:
 * the flag lands in the file, the watcher re-indexes it, and the sidebar's
 * Pinned section follows from the index — no UI-side pin state. Toggling off
 * always clears any explicit `pinned: <order>`; toggling on writes a bare
 * `pinned: true` (drag reorder writes orders).
 *
 * Reads the current state and writes the flip through {@link readNoteSource} /
 * {@link commitNoteFrontmatter} — the shared session-or-disk channel that keeps
 * our own write from parking a conflict under a dirty buffer (and never reads a
 * still-loading buffer). `pinned: false` deletes the key: unpinned is the
 * absence of the flag, so a note whose only metadata was the pin returns to
 * having no frontmatter at all.
 *
 * The index lags this write by a watcher round trip, so the new state is also
 * asserted as a note-row overlay. That assertion lives here rather than at each
 * button because ⌘O, the palette, the context sidebar, the mobile menu and the
 * mobile row all funnel through this one function: asserting here is the only
 * way every entry point reflects the flip at once. It retires on its own when
 * the index agrees, and a failed write retracts it.
 *
 * Returns the note's new pinned state.
 */
export async function toggleNotePinned(path: string, generation: number): Promise<boolean> {
  const source = await readNoteSource(path)
  const pinned = !isPinned(parseNote({ path, source }).frontmatter)
  setNoteRowOverlay(path, generation, { isPinned: pinned })
  try {
    await commitNoteFrontmatter(path, { pinned }, generation)
  } catch (cause) {
    clearNoteRowOverlay(path, generation, { isPinned: true })
    throw cause
  }
  return pinned
}

/**
 * Remove a note from the pinned shelf without reading its current state.
 * Directional UI, such as a native "Unpin Note" menu item, must not call the
 * toggle path because a stale index could otherwise turn the action into a pin.
 */
export async function unpinNote(path: string, generation: number): Promise<void> {
  setNoteRowOverlay(path, generation, { isPinned: false })
  try {
    await commitNoteFrontmatter(path, { pinned: false }, generation)
  } catch (cause) {
    clearNoteRowOverlay(path, generation, { isPinned: true })
    throw cause
  }
}

export async function reorderPinnedNotes(
  notes: readonly PinnedNote[],
  generation: number,
): Promise<void> {
  await Promise.all(
    notes.map((note, order) => commitNoteFrontmatter(note.path, { pinned: order }, generation)),
  )
}
