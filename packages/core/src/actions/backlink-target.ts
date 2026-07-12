import { ReflectError } from '../errors'
import { readNote } from '../graph/commands'
import { resolveOrCreateNoteWithTitle } from '../graph/create-note'
import { wikiLinkSafe } from '../markdown/edit'
import { parseNote } from '../markdown/extract'

/**
 * Resolve the note targeted by an automatic backlink, or create it safely.
 * Existing duplicates use the same sorted-first winner as read-only wiki-link
 * resolution. That ambiguity must not block durable capture, and no new note
 * is created in that case. Returns a link-safe current title so renames keep
 * one section; an unsafe title falls back to the requested spelling that just
 * resolved as its alias.
 */
export async function ensureBacklinkTarget(title: string, generation: number): Promise<string> {
  const outcome = await resolveOrCreateNoteWithTitle(title, generation)
  const path =
    outcome.kind === 'ambiguous' ? [...outcome.paths].sort().at(0) : outcome.path
  if (path === undefined) {
    throw new ReflectError(
      'unknown',
      `The [[${title}]] backlink target could not be resolved.`,
    )
  }
  const source = await readNote(path, generation)
  const currentTitle = parseNote({ path, source }).title
  return wikiLinkSafe(currentTitle) === currentTitle ? currentTitle : title
}
