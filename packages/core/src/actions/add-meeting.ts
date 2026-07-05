import { contactDetailsMarkdown } from '../contacts/markdown'
import { resolveAttendeeContact } from '../contacts/resolve'
import { isAppError } from '../errors'
import { noteExists, readNote, writeNote } from '../graph/commands'
import { createNoteWithTitle } from '../graph/create-note'
import { dailyPath, notePath } from '../graph/paths'
import { resolveWikiTarget } from '../indexing/queries'
import { appendUnderHeading, wikiLinkSafe } from '../markdown/edit'
import { parseNote } from '../markdown/extract'
import { foldKey } from '../markdown/keys'
import { slugForTitle } from '../markdown/slug'
import { resolveMeetingAttendees } from './resolve-attendees'

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
 * Attendees resolve by invite email first ({@link resolveMeetingAttendees}):
 * a `#person`-tagged note owning the address via a `- Email:` bullet supplies
 * the link name, so a person keeps one note however the calendar spelled
 * them. With the
 * contacts integration on (docs/porting/contacts-integration.md), a fresh
 * person note is named and pre-filled from the Apple Contacts entry matching
 * the attendee's invite email. After that, they are ordinary notes; nothing
 * stays tied to the calendar, and no event metadata is persisted beyond this
 * markdown.
 *
 * Wiki links resolve by title, so "one note per meeting title" holds by
 * construction: a recurring "Standup" links the same `[[Standup]]` note from
 * every day it's added.
 *
 * One deliberate v1 deviation: v1 nested an empty bullet under the line as a
 * note-taking caret target. The v2 serializer drops empty list items (the
 * lazy-daily contract), so writing one would just be normalized away.
 */

/** Where the daily-note entry lands (`appendUnderHeading` creates it). */
export const MEETINGS_HEADING = 'Meetings'

/** Created notes are typed like v1 tagged them (`- Type: #link` in capture is
 * the same convention); `#person` feeds the All Notes person filter. */
const MEETING_NOTE_BODY = '- Type: #meeting'
const PERSON_NOTE_BODY = '- Type: #person'

/** One attendee entering the flow: the display name that becomes the
 * `[[Person]]` link, plus the invite email (when the calendar knew it) that
 * the contacts lookup resolves by. */
export interface MeetingAttendee {
  name: string
  email?: string | undefined
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
   * a missing person note is pre-filled from the Apple Contacts entry
   * matching the attendee's invite email; off — or on a lookup miss — the
   * note is created bare, as v1 did.
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
 * that the watcher → index pipeline hasn't caught up with (adding two
 * meetings that share an attendee back-to-back must not mint `alice-2`).
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
  const heading = headings.find(
    (candidate) => candidate.text.toLowerCase() === MEETINGS_HEADING.toLowerCase(),
  )
  if (!heading) {
    return false
  }
  const sectionEnd =
    headings.find(
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
function normalizeAttendees(attendees: MeetingAttendee[]): MeetingAttendee[] {
  const seen = new Set<string>()
  const normalized: MeetingAttendee[] = []
  for (const attendee of attendees) {
    const name = wikiLinkSafe(attendee.name)
    const key = name.toLowerCase()
    if (name === '' || seen.has(key)) {
      continue
    }
    seen.add(key)
    normalized.push(attendee.email === undefined ? { name } : { name, email: attendee.email })
  }
  return normalized
}

/**
 * The body a fresh person note is born with. On the contacts path — gate on
 * and an invite email known — a matched contact's details block (typed
 * `- Type: #person` by {@link contactDetailsMarkdown}); in every other case
 * (gate off, no email, lookup miss, or a contact with nothing to write),
 * v1's bare typing line.
 */
async function personNoteBody(attendee: MeetingAttendee, lookupContacts: boolean): Promise<string> {
  if (!lookupContacts || attendee.email === undefined) {
    return PERSON_NOTE_BODY
  }
  const contact = await resolveAttendeeContact(attendee.email)
  if (contact === null) {
    return PERSON_NOTE_BODY
  }
  const details = contactDetailsMarkdown(contact)
  return details === '' ? PERSON_NOTE_BODY : details
}

/**
 * The daily-note bullet, in v1's `generateMeetingListItem` shape:
 * `- 9:00am met with [[Ada]], [[Bob]] for [[Standup]]`. Attendee-less events
 * shorten to `- 9:00am [[Standup]]`; without a start time the phrasing
 * capitalizes to `Met with`; an un-backlinked meeting name is plain text.
 */
export function meetingLine(input: {
  title: string
  attendees: string[]
  backlinkMeeting: boolean
  startTime?: string | undefined
}): string {
  const parts: string[] = []
  if (input.startTime) {
    parts.push(`${input.startTime} `)
  }
  if (input.attendees.length > 0) {
    parts.push(input.startTime ? 'met with ' : 'Met with ')
    parts.push(input.attendees.map((name) => `[[${name}]]`).join(', '))
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
    await resolveMeetingAttendees(input.attendees, lookupContacts),
  ).filter((attendee) => attendee.name.toLowerCase() !== title.toLowerCase())
  const line = meetingLine({
    title,
    attendees: attendees.map((attendee) => attendee.name),
    backlinkMeeting: input.backlinkMeeting,
    startTime: input.startTime,
  })
  await writeNote(daily, appendUnderHeading(source, MEETINGS_HEADING, line), input.generation)

  const createdNotes: string[] = []
  if (input.backlinkMeeting && !(await titleHasNote(title))) {
    await createNoteWithTitle(title, input.generation, MEETING_NOTE_BODY)
    createdNotes.push(title)
  }
  for (const attendee of attendees) {
    if (await titleHasNote(attendee.name)) {
      continue
    }
    const body = await personNoteBody(attendee, lookupContacts)
    await createNoteWithTitle(attendee.name, input.generation, body)
    createdNotes.push(attendee.name)
  }

  return { appended: true, createdNotes }
}
