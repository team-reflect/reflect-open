import { isPinned, parseNote, type PinnedNote } from '@reflect/core'
import { commitNoteFrontmatter, readNoteSource } from '@/lib/note-frontmatter'

/**
 * Toggle a note's `pinned` frontmatter flag. Markdown is the source of truth:
 * the flag lands in the file, the watcher re-indexes it, and the sidebar's
 * Pinned section follows from the index — no UI-side pin state. Toggling off
 * always clears any explicit `pinned: <order>`; toggling on writes a bare
 * `pinned: true` (the reorder UI, when it lands, is what writes orders).
 *
 * Reads the current state and writes the flip through {@link readNoteSource} /
 * {@link commitNoteFrontmatter} — the shared session-or-disk channel that keeps
 * our own write from parking a conflict under a dirty buffer (and never reads a
 * still-loading buffer). `pinned: false` deletes the key: unpinned is the
 * absence of the flag, so a note whose only metadata was the pin returns to
 * having no frontmatter at all.
 *
 * Returns the note's new pinned state.
 */
export async function toggleNotePinned(path: string, generation: number): Promise<boolean> {
  const source = await readNoteSource(path)
  const pinned = !isPinned(parseNote({ path, source }).frontmatter)
  await commitNoteFrontmatter(path, { pinned }, generation)
  return pinned
}

/**
 * Persist the visible pinned shelf order back into note frontmatter. The shelf
 * stores order in markdown (`pinned: 0`, `pinned: 1`, …), so sync/export/index
 * rebuilds all preserve the user's manual sort.
 */
export async function reorderPinnedNotes(
  notes: readonly PinnedNote[],
  generation: number,
): Promise<void> {
  await Promise.all(
    notes.map((note, order) => commitNoteFrontmatter(note.path, { pinned: order }, generation)),
  )
}
