import { splitFrontmatter } from '@reflect/core'
import { readExistingNoteSource } from '@/lib/read-existing-note-source'
import { readNoteSource } from '@/lib/note-frontmatter'

/**
 * A note's preview pieces, carved from its freshest source.
 */

export interface NotePreviewBody {
  /** The full note source, frontmatter included. */
  source: string
  /** The YAML text between the fences, or `null` without a frontmatter block. */
  frontmatter: string | null
  /** The markdown body after the frontmatter. */
  body: string
}

/**
 * Resolve a note's passive preview body, preferring the open session's live
 * buffer and falling back to a generation-pinned read — the same chain the
 * editor's wiki-link hover card uses, shared so the resident preview panel
 * renders the same snapshot a hover would. Pass `generation` to pin the read
 * to the issuing graph session; without it the read follows the open session
 * or the current graph's disk.
 */
export async function resolveNotePreviewBody(
  path: string,
  generation?: number,
): Promise<NotePreviewBody> {
  const source =
    generation === undefined
      ? await readNoteSource(path)
      : await readExistingNoteSource(path, generation)
  const { raw, body } = splitFrontmatter(source)
  return { source, frontmatter: raw, body }
}
