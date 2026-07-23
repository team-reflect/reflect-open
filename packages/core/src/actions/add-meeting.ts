import { contactDetailsMarkdown } from '../contacts/markdown'
import { ensurePersonNote } from '../contacts/person'
import { resolveAttendeeContact } from '../contacts/resolve'
import { isAppError } from '../errors'
import { noteExists, readNote, writeNote } from '../graph/commands'
import { createNoteWithTitle } from '../graph/create-note'
import { dailyPath, notePath } from '../graph/paths'
import { resolveWikiTarget } from '../indexing/queries'
import { appendListItemUnderHeading, wikiLinkSafe } from '../markdown/edit'
import { canonicalEmails } from '../markdown/email-fields'
import { parseNote } from '../markdown/extract'
import { topLevelHeadings } from '../markdown/heading-blocks'
import { foldKey } from '../markdown/keys'
import { slugForTitle } from '../markdown/slug'
import {
  resolveMeetingAttendeeTargets,
  type ResolvedMeetingAttendee,
} from './resolve-attendees'

/**
 * "Add to daily note" for a calendar event — the write half of the calendar
 * integration (docs/porting/calendar-meetings-integration.md). Submitting the
 * add-meeting dialog appends v1's exact line shape under the daily note's
 * `## Meetings` heading:
 *
 *     - 9:00am met with [[Ada Lovelace]], [[Bob]] for [[Standup]]
 *
 * and creates the notes those links resolve to when they don't exist yet.
 * With "Create backlinked note" off, the meeting name is plain text (as in
 * v1), not a link — only attendees get `[[Person]]` links and notes.
 *
 * Attendees resolve by all known emails first
 * ({@link resolveMeetingAttendeeTargets}). A unique `#person` owner supplies
 * the verified link address. A conflict stays plain text. With Contacts on, a
 * missing attendee collects the Contact's other emails before that decision
 * and can use its phone details when the note is created.
 *
 * Wiki links resolve by title, so "one note per meeting title" holds by
 * construction: a recurring "Standup" links the same `[[Standup]]` note from
 * every day it's added.
 *
 * One deliberate v1 deviation: v1 nested an empty bullet under the line as a
 * note-taking caret target. The v2 serializer drops empty list items (the
 * lazy-daily contract), so writing one would just be normalized away.
 */

/** Where the daily-note entry lands (`appendListItemUnderHeading` creates it). */
export const MEETINGS_HEADING = 'Meetings'

/** Created notes are typed like v1 tagged them (`- Type: #link` in capture is
 * the same convention); `#person` feeds the All Notes person filter. */
const MEETING_NOTE_BODY = '- Type: #meeting'
const PERSON_NOTE_BODY = '- Type: #person'

/** One attendee entering the flow: a display name and every known email. */
export interface MeetingAttendee {
  name: string
  emails?: readonly string[] | undefined
}

export interface AddMeetingInput {
  /** ISO `YYYY-MM-DD` day of the daily note receiving the entry. */
  date: string
  /** Meeting name — becomes the `[[Meeting]]` link text and note title. */
  title: string
  /** Attendees — each becomes a `[[Person]]` link and (maybe) a note. */
  attendees: MeetingAttendee[]
  /**
   * The dialog's "Create backlinked note?" choice (v1's `backlinkMeeting`):
   * on links the meeting name and creates its note when missing; off writes
   * the name as plain text and creates nothing for it.
   */
  backlinkMeeting: boolean
  /**
   * The contacts gate, computed by the caller at submit time
   * (`settings.contactsEnabled && isContactsReadable(authorization)`). On,
   * a missing person note can include phone details from the Apple Contacts
   * entry matching an attendee email. Known emails are written either way.
   */
  lookupContacts?: boolean
  /**
   * The event's start time, already formatted for display (the caller owns
   * the time-format preference, as v1 did). Omitted, the line starts at
   * "Met with …".
   */
  startTime?: string
  /** `GraphInfo.generation` — pins every read and write to the issuing graph. */
  generation: number
}

export interface AddMeetingOutcome {
  /**
   * Whether the daily note gained a line — `false` means this meeting was
   * already linked on that day (re-adding is idempotent).
   */
  appended: boolean
  /** Titles that got a fresh note in this call. */
  createdNotes: string[]
}

/** A note's source at `generation`, where "no note yet" reads as empty. */
async function noteSource(path: string, generation: number): Promise<string> {
  try {
    return await readNote(path, generation)
  } catch (cause) {
    if (isAppError(cause) && cause.kind === 'notFound') {
      return ''
    }
    throw cause
  }
}

/**
 * Does a note this title resolves to already exist? The index answers by
 * title/alias; the slug-path check backstops it for notes written moments ago
 * that the watcher → index pipeline has not caught up with.
 */
async function titleHasNote(title: string): Promise<boolean> {
  const resolution = await resolveWikiTarget(title)
  if (resolution.kind === 'resolved') {
    return true
  }
  return noteExists(notePath(slugForTitle(title)))
}

/**
 * Is `title` already linked under the daily note's `## Meetings` section?
 * The check mirrors wiki-link resolution: parsed links only, case-insensitive
 * (`foldKey`), and alias forms (`[[Standup|Daily sync]]`) count. Links
 * elsewhere in the note deliberately don't — mentioning a meeting in prose
 * must not swallow the calendar entry.
 */
function meetingAlreadyLinked(source: string, title: string): boolean {
  const { headings, wikiLinks } = parseNote({ path: '', source })
  const sectionHeadings = topLevelHeadings(source, headings)
  const heading = sectionHeadings.find(
    (candidate) => candidate.text.toLowerCase() === MEETINGS_HEADING.toLowerCase(),
  )
  if (!heading) {
    return false
  }
  const sectionEnd =
    sectionHeadings.find(
      (candidate) => candidate.from > heading.from && candidate.level <= heading.level,
    )?.from ?? source.length
  const titleKey = foldKey(title)
  return wikiLinks.some((link) => {
    if (link.from < heading.to || link.from >= sectionEnd) {
      return false
    }
    // The alias counts too: `[[Standup|Daily sync]]` already shows this
    // meeting under its calendar name, even though the link targets another
    // note title.
    return (
      foldKey(link.target) === titleKey ||
      (link.alias !== undefined && foldKey(link.alias) === titleKey)
    )
  })
}

/** Attendees with sanitized names, case-insensitively name-deduplicated, order kept. */
function normalizeAttendees(
  attendees: readonly ResolvedMeetingAttendee[],
): ResolvedMeetingAttendee[] {
  const seen = new Set<string>()
  const normalized: ResolvedMeetingAttendee[] = []
  for (const resolved of attendees) {
    const name = wikiLinkSafe(resolved.attendee.name)
    const key = name.toLowerCase()
    if (name === '' || seen.has(key)) {
      continue
    }
    seen.add(key)
    const emails = canonicalEmails(resolved.attendee.emails ?? [])
    const attendee = emails.length === 0 ? { name } : { name, emails }
    normalized.push({ ...resolved, attendee })
  }
  return normalized
}

/**
 * The body a fresh person note is born with. Every resolved email is written.
 * When Contacts is readable, phone details from the same Contact are included
 * without adding emails that ownership resolution did not already inspect.
 */
async function personNoteBody(attendee: MeetingAttendee, lookupContacts: boolean): Promise<string> {
  const emails = canonicalEmails(attendee.emails ?? [])
  if (lookupContacts && emails[0] !== undefined) {
    const contact = await resolveAttendeeContact(emails[0])
    if (contact !== null) {
      const details = contactDetailsMarkdown({ ...contact, emails })
      if (details !== '') {
        return details
      }
    }
  }
  return [
    PERSON_NOTE_BODY,
    ...emails.map((email) => `- Email: ${email}`),
  ].join('\n')
}

/** One attendee fragment ready for daily-note Markdown serialization. */
export type MeetingLineAttendee =
  | { readonly kind: 'linked'; readonly insertText: string }
  | { readonly kind: 'plain'; readonly text: string }

/**
 * The daily-note bullet, in v1's `generateMeetingListItem` shape:
 * `- 9:00am met with [[Ada]], [[Bob]] for [[Standup]]`. Attendee-less events
 * shorten to `- 9:00am [[Standup]]`; without a start time the phrasing
 * capitalizes to `Met with`; an un-backlinked meeting name is plain text.
 */
export function meetingLine(input: {
  title: string
  attendees: readonly MeetingLineAttendee[]
  backlinkMeeting: boolean
  startTime?: string | undefined
}): string {
  const parts: string[] = []
  if (input.startTime) {
    parts.push(`${input.startTime} `)
  }
  if (input.attendees.length > 0) {
    parts.push(input.startTime ? 'met with ' : 'Met with ')
    parts.push(
      input.attendees
        .map((attendee) =>
          attendee.kind === 'linked'
            ? `[[${attendee.insertText}]]`
            : attendee.text,
        )
        .join(', '),
    )
    parts.push(' for ')
  }
  parts.push(input.backlinkMeeting ? `[[${input.title}]]` : input.title)
  return `- ${parts.join('')}`
}

/**
 * Write a meeting into the day's note (see the module doc). The daily append
 * lands first — it is the durable, user-visible artifact — and note creation
 * follows; a failure in between leaves unresolved links that create their
 * notes on click, so every partial outcome is still coherent.
 */
export async function addMeetingToDaily(input: AddMeetingInput): Promise<AddMeetingOutcome> {
  const title = wikiLinkSafe(input.title)
  if (title === '') {
    throw new Error('a meeting needs a name')
  }
  const lookupContacts = input.lookupContacts ?? false

  const daily = dailyPath(input.date)
  const source = await noteSource(daily, input.generation)
  // An already-linked meeting makes the whole call a no-op — appending
  // nothing but still creating notes would be surprising. A run that failed
  // between the append and note creation still heals: the line's unresolved
  // links create their notes on click. (A plain-text line — backlink off —
  // carries no link to match against, so, like v1, it always appends.)
  if (input.backlinkMeeting && meetingAlreadyLinked(source, title)) {
    return { appended: false, createdNotes: [] }
  }
  // Canonicalize by invite email before deduplicating: an attendee whose
  // address an existing note owns takes that note's title, so two spellings
  // of one person collapse here and the link below lands on their note. An
  // attendee spelled like the meeting itself (a shared mailbox, a 1:1 named
  // after the person) would just duplicate the link — drop it.
  const attendees = normalizeAttendees(
    await resolveMeetingAttendeeTargets(input.attendees, lookupContacts),
  ).filter(
    ({ attendee }) => attendee.name.toLowerCase() !== title.toLowerCase(),
  )
  const line = meetingLine({
    title,
    attendees: attendees.map((resolved) =>
      resolved.kind === 'plain'
        ? { kind: 'plain', text: resolved.attendee.name }
        : { kind: 'linked', insertText: resolved.insertText },
    ),
    backlinkMeeting: input.backlinkMeeting,
    startTime: input.startTime,
  })
  await writeNote(
    daily,
    appendListItemUnderHeading(source, MEETINGS_HEADING, line),
    input.generation,
  )

  const createdNotes: string[] = []
  if (input.backlinkMeeting && !(await titleHasNote(title))) {
    await createNoteWithTitle(title, input.generation, MEETING_NOTE_BODY)
    createdNotes.push(title)
  }
  for (const resolved of attendees) {
    if (resolved.kind !== 'new') {
      continue
    }
    const { attendee } = resolved
    const body = await personNoteBody(attendee, lookupContacts)
    const outcome = await ensurePersonNote({
      title: attendee.name,
      emails: attendee.emails ?? [],
      body,
      generation: input.generation,
    })
    if (outcome.kind === 'created') {
      createdNotes.push(attendee.name)
    }
  }

  return { appended: true, createdNotes }
}
