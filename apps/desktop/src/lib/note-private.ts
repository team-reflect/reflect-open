import { parseNote, upsertFrontmatter, writeNote } from '@reflect/core'
import { openSession } from '@/editor/open-documents'
import { readNoteOrEmpty } from '@/lib/note-read'

/**
 * Toggle a note's `private` frontmatter flag — the hard block that keeps the
 * note's content away from AI and every other external service. It is privacy
 * from cloud services, not encryption or a local-search filter (the product
 * vision's contract). Markdown is the source of truth: the flag lands in the
 * file, the watcher re-indexes it, and `notes.isPrivate` follows from the
 * index — no UI-side privacy state. Toggling off removes the key entirely:
 * not-private is the absence of the flag, and frontmatter stays minimal.
 *
 * Routes through the live session whenever the note is open, exactly like
 * `toggleNotePinned`: a direct disk write under a dirty buffer would
 * park a conflict caused by our own action, and "keep mine" would silently
 * undo the flag. The session's `commitFrontmatter` owns making the patch land
 * immediately — parked-conflict handling included. With no live session (or
 * one that can't take patches), a read-patch-write on disk is reconciled by
 * any loading/clean session like an external change.
 *
 * Returns the note's new private state.
 */
export async function toggleNotePrivate(path: string, generation: number): Promise<boolean> {
  const owner = openSession(path)
  if (owner !== null) {
    const isPrivate = !parseNote({ path, source: owner.content() }).frontmatter.private
    if (await owner.commitFrontmatter({ private: isPrivate })) {
      return isPrivate
    }
  }
  const content = await readNoteOrEmpty(path)
  const isPrivate = !parseNote({ path, source: content }).frontmatter.private
  const patched = upsertFrontmatter(content, { private: isPrivate ? true : undefined })
  if (patched !== content) {
    await writeNote(path, patched, generation)
  }
  return isPrivate
}
