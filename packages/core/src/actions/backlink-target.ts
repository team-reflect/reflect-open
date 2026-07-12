import { ReflectError } from '../errors'
import { readNote } from '../graph/commands'
import { resolveOrCreateNoteWithTitle } from '../graph/create-note'
import { wikiLinkSafe } from '../markdown/edit'
import { parseNote } from '../markdown/extract'

/**
 * Resolve the note targeted by an automatic backlink, or create it safely.
 * Existing duplicates use the same sorted-first winner as read-only wiki-link
 * resolution. That ambiguity must not block durable capture, and no new note
 * is created in that case. An unavailable match (an iCloud placeholder or a
 * failed read) must not block capture either: the requested spelling is kept
 * unchanged and resolves once the note is readable on this device. Returns a
 * link-safe current title so renames keep one section; an unsafe title falls
 * back to the requested spelling that just resolved as its alias.
 */
export async function ensureBacklinkTarget(title: string, generation: number): Promise<string> {
  const outcome = await resolveOrCreateNoteWithTitle(title, generation)
  if (outcome.kind === 'unavailable') {
    return title
  }
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
