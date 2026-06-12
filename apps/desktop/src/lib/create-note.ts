import { ulid } from 'ulidx'
import {
  availableNotePath,
  notePath,
  slugForTitle,
  upsertFrontmatter,
  writeNote,
} from '@reflect/core'

/**
 * Note identity at creation (`docs/readable-filenames.md`): regular notes get
 * a **title-derived filename** (`notes/<slug>.md`, `-2` suffix on collision)
 * and a frontmatter
 * `id:` ULID — the durable identity Plan 02 specified, which survives the
 * renames that now follow title changes (17b).
 */

/** A fresh frontmatter `id` (lowercase ULID, matching the filename convention). */
export function newNoteId(): string {
  return ulid().toLowerCase()
}

/** The on-disk source for a brand-new note: `id:` frontmatter + H1 title. */
export function newNoteSource(title: string): string {
  return upsertFrontmatter(`# ${title.trim()}\n`, { id: newNoteId() })
}

/**
 * The buffer seed for a ⌘N note (created lazily on the first keystroke): the
 * selectable "Untitled" H1 plus a fresh `id:`. The id rides the seed's header
 * through the session, so it lands on disk with the note's first real save.
 */
export function untitledNoteSeed(): string {
  return upsertFrontmatter('# Untitled\n', { id: newNoteId() })
}

/**
 * The birth path for a ⌘N note: no title exists yet, so the filename is a
 * ULID placeholder — the first settled title replaces it with the slug
 * (Plan 17's birth rename). The one author of the ULID-path convention.
 */
export function untitledNotePath(): string {
  return notePath(newNoteId())
}

/**
 * Create a new note titled `title` (Plan 07's create-from-unresolved) at a
 * collision-free slug path. Returns the new graph-relative path. The write
 * carries `generation`, so a create racing a graph switch is rejected loudly
 * instead of landing in the wrong graph.
 */
export async function createNoteWithTitle(title: string, generation: number): Promise<string> {
  const path = await availableNotePath(slugForTitle(title))
  await writeNote(path, newNoteSource(title), generation)
  return path
}
