import {
  appendContactDetails,
  contactDetailsMarkdown,
  contactNamesEqual,
  createNoteWithTitle,
  matchContactForTitle,
  noteExists,
  noteHasContactDetails,
  notePath,
  parseNote,
  slugForTitle,
  splitFrontmatter,
  writeNote,
  type ContactMatch,
} from '@reflect/core'
import { openSession } from '@/editor/open-documents'
import { commitNoteFrontmatter, readNoteSource } from '@/lib/note-frontmatter'

/**
 * The suggested-contact card's two resolutions (the contacts-integration
 * port), with v1's suppression model: **Add** lands the contact's details in
 * the body as plain markdown — the details themselves then hide the card
 * (`noteHasContactDetails`), so Add is a single write with no frontmatter
 * mark. **Ignore** records the contact's name in the note's
 * `ignoredContacts` frontmatter list — per contact, so a retitled note stays
 * eligible for its own suggestion. Nothing ever syncs back to the address
 * book.
 */

/**
 * Action-time revalidation: the card's suggestion is a cached query, but the
 * title may have been edited (even unsaved) since it resolved. Returns the
 * live source when the note still carries the contact's name, else null —
 * a stale card must neither merge the wrong details nor dismiss the new
 * title's own suggestion.
 */
async function sourceIfStillMatching(
  path: string,
  contact: ContactMatch,
): Promise<string | null> {
  const source = await readNoteSource(path)
  const title = parseNote({ path, source }).title
  return matchContactForTitle(title, [contact]) === null ? null : source
}

/**
 * Merge `contact`'s details into the note: the `- Type: #person` typing line
 * plus every email and phone, appended as their own block. Routes through
 * the live session when the note is open — the card sits above an open
 * editor, so unsaved edits must survive — and refuses rather than clobber
 * when the session can't take it (loading, protected, or a parked conflict).
 * A closed note is patched on disk. Retry-safe: a body that already carries
 * the details is left alone.
 */
export async function addContactToNote(
  path: string,
  contact: ContactMatch,
  generation: number,
): Promise<void> {
  const source = await sourceIfStillMatching(path, contact)
  if (source === null) {
    throw new Error('The note title no longer matches this contact.')
  }
  const body = splitFrontmatter(source).body
  // The same content gate the card renders through: a body that already
  // carries contact details — a previous Add's block, or an email the user
  // typed under a still-cached card — must not get a (second) block. The
  // body-aware block also drops the `- Type: #person` line when the note was
  // already typed at creation (meeting flow, link menu).
  const details = contactDetailsMarkdown(contact, body)
  if (details === '' || noteHasContactDetails(body)) {
    return
  }
  const owner = openSession(path)
  if (owner !== null) {
    if (!(await owner.commitBodyAppend(details))) {
      throw new Error('This note can’t be updated right now — try again in a moment.')
    }
    return
  }
  // Reuse the validated snapshot — with no session, `source` came from disk.
  // A second read here would reopen the window between the check and the write.
  await writeNote(path, appendContactDetails(source, contact), generation)
}

/**
 * Create a person note from a `[[` link-menu contact row (v1's backlink-menu
 * behavior): titled with the contact's name and prefilled with the same
 * details block Add writes. The row only appears when no suggestion resolves
 * to the name, so the note shouldn't exist — the direct existence check
 * backstops index lag, ensuring a race never mints an `ada-lovelace-2.md`
 * beside the real person note.
 */
export async function createPersonNoteFromContact(
  contact: ContactMatch,
  generation: number,
): Promise<void> {
  if (await noteExists(notePath(slugForTitle(contact.fullName)))) {
    return
  }
  await createNoteWithTitle(contact.fullName, generation, contactDetailsMarkdown(contact))
}

/**
 * Dismiss the suggestion for this note: record `contact`'s name in the
 * `ignoredContacts` frontmatter list, write nothing else. A stale card (the
 * title no longer matches `contact`) skips the write silently — the user
 * wanted the card gone, and the new title must stay eligible for its own
 * suggestion.
 */
export async function ignoreContactSuggestion(
  path: string,
  contact: ContactMatch,
  generation: number,
): Promise<void> {
  const source = await sourceIfStillMatching(path, contact)
  if (source === null) {
    return
  }
  const ignored = parseNote({ path, source }).frontmatter.ignoredContacts
  if (ignored.some((name) => contactNamesEqual(name, contact.fullName))) {
    return
  }
  await commitNoteFrontmatter(
    path,
    { ignoredContacts: [...ignored, contact.fullName] },
    generation,
  )
}
