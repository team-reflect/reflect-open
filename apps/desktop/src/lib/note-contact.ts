import {
  appendContactDetails,
  contactDetailsMarkdown,
  matchContactForTitle,
  parseNote,
  writeNote,
  type ContactMatch,
} from '@reflect/core'
import { openSession } from '@/editor/open-documents'
import { commitNoteFrontmatter, readNoteSource } from '@/lib/note-frontmatter'
import { readNoteOrEmpty } from '@/lib/note-read'

/**
 * The suggested-contact card's two resolutions (the contacts-integration
 * port). Both leave a `contactSuggestion` frontmatter mark so the card never
 * reappears for a handled note; **Add** additionally lands the contact's
 * details in the body as plain markdown — ordinary note content owned by the
 * graph from that moment on, never synced back to the address book.
 */

/**
 * Merge `contact`'s details into the note (primary email/phone bullets,
 * appended as their own block) and mark the suggestion `added`. Routes the
 * body edit through the live session when the note is open — the card sits
 * above an open editor, so unsaved edits must survive — and refuses rather
 * than clobber when the session can't take it (loading, protected, or a
 * parked conflict). A closed note is patched on disk.
 */
/**
 * Action-time revalidation: the card's suggestion is a cached query, but the
 * title may have been edited (even unsaved) since it resolved. Returns the
 * live source when the note still carries the contact's name, else null —
 * a stale card must neither merge the wrong details nor mark the new title
 * as handled.
 */
async function sourceIfStillMatching(
  path: string,
  contact: ContactMatch,
): Promise<string | null> {
  const source = await readNoteSource(path)
  const title = parseNote({ path, source }).title
  return matchContactForTitle(title, [contact]) === null ? null : source
}

export async function addContactToNote(
  path: string,
  contact: ContactMatch,
  generation: number,
): Promise<void> {
  const source = await sourceIfStillMatching(path, contact)
  if (source === null) {
    throw new Error('The note title no longer matches this contact.')
  }
  const details = contactDetailsMarkdown(contact)
  // Idempotency guard: the append and the mark are two writes, so a retry
  // after a failed mark (details landed, card still up) must not append the
  // same bullets again.
  const alreadyAdded = details === '' || source.includes(details)
  if (!alreadyAdded) {
    const owner = openSession(path)
    if (owner !== null) {
      if (!(await owner.commitBodyAppend(details))) {
        throw new Error('This note can’t be updated right now — try again in a moment.')
      }
    } else {
      const onDisk = await readNoteOrEmpty(path)
      await writeNote(path, appendContactDetails(onDisk, contact), generation)
    }
  }
  await commitNoteFrontmatter(path, { contactSuggestion: 'added' }, generation)
}

/**
 * Dismiss the suggestion for this note: mark it `ignored`, write nothing
 * else. A stale card (the title no longer matches `contact`) skips the mark
 * silently — the user wanted the card gone, and the new title must stay
 * eligible for its own suggestion.
 */
export async function ignoreContactSuggestion(
  path: string,
  contact: ContactMatch,
  generation: number,
): Promise<void> {
  if ((await sourceIfStillMatching(path, contact)) === null) {
    return
  }
  await commitNoteFrontmatter(path, { contactSuggestion: 'ignored' }, generation)
}
