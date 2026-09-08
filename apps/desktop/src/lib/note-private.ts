import { parseNote } from '@reflect/core'
import { clearNoteRowOverlay, setNoteRowOverlay } from '@/hooks/note-row-overlay'
import { commitNoteFrontmatter, readNoteSource } from '@/lib/note-frontmatter'

/**
 * Toggle a note's `private` frontmatter flag — the hard block that keeps the
 * note's content away from AI and every other external service. It is privacy
 * from cloud services, not encryption or a local-search filter (the product
 * vision's contract). Markdown is the source of truth: the flag lands in the
 * file, the watcher re-indexes it, and `notes.isPrivate` follows from the
 * index — no UI-side privacy state. Toggling off removes the key entirely:
 * not-private is the absence of the flag, and frontmatter stays minimal.
 *
 * Reads the current state and writes the flip through {@link readNoteSource} /
 * {@link commitNoteFrontmatter}, exactly like `toggleNotePinned`: the shared
 * session-or-disk channel keeps our own write from parking a conflict under a
 * dirty buffer (and never reads a still-loading buffer). It asserts the new
 * flag as a note-row overlay for the same reason too — the palette command and
 * the two toggle buttons all funnel through here, so this is the one place an
 * assertion reaches every one of them.
 *
 * Returns the note's new private state.
 */
export async function toggleNotePrivate(path: string, generation: number): Promise<boolean> {
  const source = await readNoteSource(path)
  const isPrivate = !parseNote({ path, source }).frontmatter.private
  setNoteRowOverlay(path, generation, { isPrivate })
  try {
    await commitNoteFrontmatter(path, { private: isPrivate }, generation)
  } catch (cause) {
    clearNoteRowOverlay(path, generation, { isPrivate: true })
    throw cause
  }
  return isPrivate
}
