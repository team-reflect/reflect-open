import {
  resolvePerson,
  type PersonResolution,
} from '../contacts/person'
import { resolveAttendeeContact } from '../contacts/resolve'
import { serializeWikiSuggestionAddress } from '../indexing/suggest'
import { canonicalEmail, canonicalEmails } from '../markdown/email-fields'
import { wikiLinkSafe } from '../markdown/edit'
import type { MeetingAttendee } from './add-meeting'

/** An attendee classified for linked or plain-text meeting serialization. */
export type ResolvedMeetingAttendee =
  | {
      readonly kind: 'existing'
      readonly attendee: MeetingAttendee
      readonly insertText: string
    }
  | {
      readonly kind: 'new'
      readonly attendee: MeetingAttendee
      readonly insertText: string
    }
  | {
      readonly kind: 'plain'
      readonly attendee: MeetingAttendee
    }

function normalizedAttendee(
  attendee: MeetingAttendee,
  emails: readonly string[],
): MeetingAttendee {
  return emails.length === 0
    ? { name: attendee.name }
    : { name: attendee.name, emails }
}

function targetFromPerson(
  attendee: MeetingAttendee,
  resolution: PersonResolution,
): ResolvedMeetingAttendee {
  if (resolution.kind === 'existing') {
    return {
      kind: 'existing',
      attendee: {
        name: resolution.title,
        emails: resolution.emails,
      },
      insertText: resolution.insertText,
    }
  }
  if (resolution.kind === 'blocked') {
    return {
      kind: 'plain',
      attendee: normalizedAttendee(attendee, resolution.emails),
    }
  }
  const name = wikiLinkSafe(attendee.name)
  const insertText = serializeWikiSuggestionAddress(name, null)
  if (insertText === null) {
    return {
      kind: 'plain',
      attendee: normalizedAttendee(attendee, resolution.emails),
    }
  }
  return {
    kind: 'new',
    attendee:
      resolution.emails.length === 0
        ? { name }
        : { name, emails: resolution.emails },
    insertText,
  }
}

async function resolveMeetingAttendee(
  attendee: MeetingAttendee,
  lookupContacts: boolean,
): Promise<ResolvedMeetingAttendee> {
  const emails = canonicalEmails(attendee.emails ?? [])
  let resolution = await resolvePerson(emails)
  if (resolution.kind !== 'missing') {
    return targetFromPerson(attendee, resolution)
  }

  const nameEmail = canonicalEmail(attendee.name)
  if (lookupContacts && emails[0] !== undefined) {
    const contact = await resolveAttendeeContact(emails[0])
    if (contact !== null) {
      const contactAttendee = {
        name:
          emails.includes(nameEmail) && contact.fullName.trim() !== ''
            ? contact.fullName.trim()
            : attendee.name,
        emails: canonicalEmails([...emails, ...contact.emails]),
      }
      resolution = await resolvePerson(contactAttendee.emails)
      return targetFromPerson(contactAttendee, resolution)
    }
  }
  return targetFromPerson(normalizedAttendee(attendee, emails), resolution)
}

/**
 * Resolve attendees for meeting serialization. Every Contact email participates
 * in ownership; conflicts and unaddressable owners become plain text.
 */
export async function resolveMeetingAttendeeTargets(
  attendees: readonly MeetingAttendee[],
  lookupContacts: boolean,
): Promise<ResolvedMeetingAttendee[]> {
  return Promise.all(
    attendees.map((attendee) =>
      resolveMeetingAttendee(attendee, lookupContacts),
    ),
  )
}

/**
 * Resolve the editable attendee chips. Existing owners use their note title;
 * blocked identities remain selectable under the original display name.
 */
export async function resolveMeetingAttendees(
  attendees: readonly MeetingAttendee[],
  lookupContacts: boolean,
): Promise<MeetingAttendee[]> {
  const resolved = await resolveMeetingAttendeeTargets(attendees, lookupContacts)
  return resolved.map(({ attendee }) => attendee)
}
