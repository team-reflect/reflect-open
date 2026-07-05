import { resolveAttendeeContact } from '../contacts/resolve'
import { noteTitleOwningEmail } from '../indexing/queries'
import { wikiLinkSafe } from '../markdown/edit'
import { foldEmail } from '../markdown/email-fields'
import type { MeetingAttendee } from './add-meeting'

/**
 * Canonicalize meeting attendees against what the graph already knows, so
 * one person keeps one note no matter how the calendar spelled them.
 *
 * Calendars are unreliable about names: EventKit reports many participants
 * by bare address (no display name), and the ones it does name can differ
 * from the note title ("Doe, Jane" vs "Jane Doe"). Matching by name alone
 * therefore mints duplicate person notes. The invite email is the stable
 * identity, so each attendee that carries one resolves in order:
 *
 * 1. **The graph.** A `#person`-tagged note owning the address via a
 *    `- Email:` contact-field bullet (the `note_emails` projection) wins
 *    outright — the attendee is renamed to that note's title, so the
 *    `[[Person]]` link lands on the existing note.
 * 2. **Apple Contacts** (gate on), only when the attendee's name *is* the
 *    address — the calendar knew no better. The contact's full name becomes
 *    the attendee, so the note the flow then creates (pre-filled with the
 *    contact's details, including this email) is born under the person's
 *    real name — and step 1 finds it next time.
 * 3. Otherwise the attendee passes through unchanged, and the flow behaves
 *    as v1 did: title match or a fresh note.
 *
 * Both the add-meeting dialog (prefilling chips) and `addMeetingToDaily`
 * (authoritatively, at write time) run this, so what the user sees is what
 * gets linked — and a quick submit can't skip the resolution.
 */
export async function resolveMeetingAttendees(
  attendees: readonly MeetingAttendee[],
  lookupContacts: boolean,
): Promise<MeetingAttendee[]> {
  return Promise.all(attendees.map((attendee) => resolveAttendee(attendee, lookupContacts)))
}

async function resolveAttendee(
  attendee: MeetingAttendee,
  lookupContacts: boolean,
): Promise<MeetingAttendee> {
  if (attendee.email === undefined || foldEmail(attendee.email) === '') {
    return attendee
  }
  const ownerTitle = await noteTitleOwningEmail(attendee.email)
  // The rename must be lossless: `[[…]]` has no escaping, so a title that
  // wikiLinkSafe would alter (brackets, pipes, doubled spaces) can't be
  // linked verbatim — the sanitized form would miss the owner in the index
  // and mint the very duplicate this resolution exists to prevent. Such an
  // owner falls through to the later steps instead.
  if (ownerTitle !== null && ownerTitle !== '' && wikiLinkSafe(ownerTitle) === ownerTitle) {
    return { name: ownerTitle, email: attendee.email }
  }
  if (lookupContacts && foldEmail(attendee.name) === foldEmail(attendee.email)) {
    const contact = await resolveAttendeeContact(attendee.email)
    if (contact !== null && contact.fullName.trim() !== '') {
      return { name: contact.fullName.trim(), email: attendee.email }
    }
  }
  return attendee
}
