import { requireGraphSession } from '../graph/graph-session.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import { isAppError } from '../errors.ts'
import type { GraphSessionService } from '../graph/graph-session-service.ts'
import type { NoteCreationService } from '../graph/note-creation-service.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { dailyPath, notePath } from '../graph/paths.ts'
import { serializeWikiSuggestionAddress, type WikiSuggestion } from '../indexing/suggest.ts'
import type { SuggestionService } from '../indexing/suggestion-service.ts'
import type { WikiResolverService } from '../indexing/wiki-resolver-service.ts'
import { wikiLinkSafe } from '../markdown/edit.ts'
import { canonicalEmail, canonicalEmails } from '../markdown/email-fields.ts'
import { parseNote } from '../markdown/extract.ts'
import { headingNamesSection, sectionEnd, topLevelHeadings } from '../markdown/heading-blocks.ts'
import { foldKey } from '../markdown/keys.ts'
import { slugForTitle } from '../markdown/slug.ts'
import { appendListItem, type SectionTarget } from '../markdown/task-ast.ts'
import type { SettingsService } from '../settings/settings-service.ts'
import type { ContactMatch, ContactsService } from './contacts-service.ts'
import { contactDetailsMarkdown } from './markdown.ts'
import type { PersonNoteService, PersonResolution } from './person-note-service.ts'
import { pickContactForEmail } from './resolve.ts'

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
 * ({@link MeetingService.resolveAttendeeTargets}). A unique `#person` owner supplies
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

/**

 * Where the daily-note entry lands (`appendListItem` creates it).

 */
export const MEETINGS_HEADING = 'Meetings'
const MEETINGS_SECTION: SectionTarget = { titles: [MEETINGS_HEADING], linked: false }

/** Created notes are typed like v1 tagged them (`- Type: #link` in capture is
 * the same convention); `#person` feeds the All Notes person filter. */
const MEETING_NOTE_BODY = '- Type: #meeting'
const PERSON_NOTE_BODY = '- Type: #person'

export interface AddMeetingInput {
  /**
   * ISO `YYYY-MM-DD` day of the daily note receiving the entry.
   */
  date: string
  /**
   * Meeting name — becomes the `[[Meeting]]` link text and note title.
   */
  title: string
  /**
   * Attendees — each becomes a `[[Person]]` link and (maybe) a note.
   */
  attendees: MeetingAttendee[]
  /**
   * The dialog's "Create backlinked note?" choice (v1's `backlinkMeeting`):
   * on links the meeting name and creates its note when missing; off writes
   * the name as plain text and creates nothing for it.
   */
  backlinkMeeting: boolean
  /**
   * The contacts gate, computed by the caller at submit time
   * ({@link MeetingService.canLookupContacts}). On,
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
}

export interface AddMeetingOutcome {
  /**
   * Whether the daily note gained a line — `false` means this meeting was
   * already linked on that day (re-adding is idempotent).
   */
  appended: boolean
  /**
   * Titles that got a fresh note in this call.
   */
  createdNotes: string[]
}

/**

 * One attendee entering the flow: a display name and every known email.

 */
export interface MeetingAttendee {
  name: string
  emails?: readonly string[] | undefined
}

/**

 * An attendee classified for linked or plain-text meeting serialization.

 */
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

function normalizedAttendee(attendee: MeetingAttendee, emails: readonly string[]): MeetingAttendee {
  return emails.length === 0 ? { name: attendee.name } : { name: attendee.name, emails }
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
    attendee: resolution.emails.length === 0 ? { name } : { name, emails: resolution.emails },
    insertText,
  }
}

export interface AttendeeSuggestions {
  /**
   * Ranked note titles, without the daily notes: an attendee is a person, not a date.
   */
  readonly suggestions: WikiSuggestion[]
  /**
   * Apple Contacts whose name matches; empty when contacts are off or the lookup failed.
   */
  readonly contacts: ContactMatch[]
}

/**
 * Is `title` already linked under the daily note's `## Meetings` section?
 * The check mirrors wiki-link resolution: parsed links only, case-insensitive
 * (`foldKey`), and alias forms (`[[Standup|Daily sync]]`) count. Links
 * elsewhere in the note deliberately don't — mentioning a meeting in prose
 * must not swallow the calendar entry.
 *
 * The scan spans the whole section, deliberately wider than where a new entry
 * would land (the section's first bullet list). "Already on the day's agenda"
 * is the question worth answering: an entry a user moved down past their own
 * notes still counts, and re-adding it would read as a duplicate.
 */
function meetingAlreadyLinked(source: string, title: string): boolean {
  const { headings, wikiLinks } = parseNote({ path: '', source })
  const sectionHeadings = topLevelHeadings(headings)
  const heading = sectionHeadings.find(
    (candidate) =>
      candidate.level <= 2 && headingNamesSection(candidate, wikiLinks, [MEETINGS_HEADING]),
  )
  if (!heading) {
    return false
  }
  const sectionEndOffset = sectionEnd(sectionHeadings, heading, source.length)
  const titleKey = foldKey(title)
  return wikiLinks.some((link) => {
    if (link.from < heading.to || link.from >= sectionEndOffset) {
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

/**

 * Attendees with sanitized names, case-insensitively name-deduplicated, order kept.

 */
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

 * One attendee fragment ready for daily-note Markdown serialization.

 */
export type MeetingLineAttendee =
  | { readonly kind: 'linked'; readonly insertText: string }
  | { readonly kind: 'plain'; readonly text: string }

/**
 * The daily-note bullet's text, in v1's `generateMeetingListItem` shape:
 * `9:00am met with [[Ada]], [[Bob]] for [[Standup]]`. Attendee-less events
 * shorten to `9:00am [[Standup]]`; without a start time the phrasing
 * capitalizes to `Met with`; an un-backlinked meeting name is plain text.
 * The bullet marker itself belongs to the list this lands in, so it is added
 * by {@link appendListItem} rather than written here.
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
          attendee.kind === 'linked' ? `[[${attendee.insertText}]]` : attendee.text,
        )
        .join(', '),
    )
    parts.push(' for ')
  }
  parts.push(input.backlinkMeeting ? `[[${input.title}]]` : input.title)
  return parts.join('')
}

/**
 * The prefilled chips after attendee resolution answered. Chips are merged by
 * their prefill name (a key of `upgrades`): anything the user removed stays
 * removed, anything they added is untouched. Names are deduplicated
 * case-insensitively, first one kept.
 */
export function mergeAttendeeUpgrades(
  current: readonly MeetingAttendee[],
  upgrades: ReadonlyMap<string, MeetingAttendee>,
): MeetingAttendee[] {
  const seen = new Set<string>()
  const merged: MeetingAttendee[] = []
  for (const attendee of current) {
    const upgraded = upgrades.get(attendee.name) ?? attendee
    const key = upgraded.name.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    merged.push(upgraded)
  }
  return merged
}

/**

 * `current` plus `attendee`, or `current` itself when the name is already there (case-insensitive).

 */
export function withAttendee(
  current: MeetingAttendee[],
  attendee: MeetingAttendee,
): MeetingAttendee[] {
  return current.some((existing) => existing.name.toLowerCase() === attendee.name.toLowerCase())
    ? current
    : [...current, attendee]
}

/**

 * Adds a calendar event to its daily note, with the attendee resolution around it.

 */
export interface MeetingService {
  /**
   * The contacts gate: the integration is enabled and the permission, as
   * {@link ContactsService} last read it, is readable.
   */
  canLookupContacts(): boolean
  /**
   * Resolve attendees for meeting serialization. Every Contact email participates
   * in ownership; conflicts and unaddressable owners become plain text.
   */
  resolveAttendeeTargets(
    attendees: readonly MeetingAttendee[],
    lookupContacts: boolean,
  ): Promise<ResolvedMeetingAttendee[]>
  /**
   * Resolve the editable attendee chips. Existing owners use their note title;
   * blocked identities remain selectable under the original display name.
   */
  resolveAttendees(
    attendees: readonly MeetingAttendee[],
    lookupContacts: boolean,
  ): Promise<MeetingAttendee[]>
  /**
   * The resolved chip of every attendee in `prefilled` (the event's
   * `defaultAttendees`), keyed by its prefill name, under the current contacts
   * gate. An invite email an existing note owns swaps the calendar's spelling
   * for the note title, so the chip shows exactly what submit will link.
   */
  resolvePrefilledAttendees(
    prefilled: readonly MeetingAttendee[],
  ): Promise<Map<string, MeetingAttendee>>
  /**
   * The rows behind the attendee field for `query`: at most `limit` note
   * suggestions and, with `lookupContacts`, the matching Apple Contacts. A
   * contacts failure is logged and costs only its own rows.
   */
  attendeeSuggestions(
    query: string,
    limit: number,
    lookupContacts: boolean,
  ): Promise<AttendeeSuggestions>
  /**
   * Write a meeting into the day's note (see the module doc). The daily append
   * lands first — it is the durable, user-visible artifact — and note creation
   * follows; a failure in between leaves unresolved links that create their
   * notes on click, so every partial outcome is still coherent. Every read and
   * write goes to the graph open when the call starts; with none it throws.
   */
  addMeetingToDaily(input: AddMeetingInput): Promise<AddMeetingOutcome>
}

export interface MeetingServiceDeps {
  readonly noteFile: NoteFileService
  readonly noteCreation: NoteCreationService
  readonly wikiResolver: WikiResolverService
  readonly suggestions: SuggestionService
  readonly personNotes: PersonNoteService
  readonly contacts: ContactsService
  readonly settings: SettingsService
  readonly logger: LoggerService
  readonly graphSession: GraphSessionService
}

class MeetingServiceImpl implements MeetingService {
  readonly #deps: MeetingServiceDeps

  constructor(deps: MeetingServiceDeps) {
    this.#deps = deps
  }

  canLookupContacts(): boolean {
    const { contacts, settings } = this.#deps
    return contacts.canLookup(settings.get())
  }

  async resolveAttendeeTargets(
    attendees: readonly MeetingAttendee[],
    lookupContacts: boolean,
  ): Promise<ResolvedMeetingAttendee[]> {
    return await Promise.all(
      attendees.map((attendee) => this.#resolveMeetingAttendee(attendee, lookupContacts)),
    )
  }

  async resolveAttendees(
    attendees: readonly MeetingAttendee[],
    lookupContacts: boolean,
  ): Promise<MeetingAttendee[]> {
    const resolved = await this.resolveAttendeeTargets(attendees, lookupContacts)
    return resolved.map(({ attendee }) => attendee)
  }

  async resolvePrefilledAttendees(
    prefilled: readonly MeetingAttendee[],
  ): Promise<Map<string, MeetingAttendee>> {
    await this.#deps.contacts.refresh()
    const lookupContacts = this.canLookupContacts()
    const resolved = await this.resolveAttendees(prefilled, lookupContacts)
    return new Map(prefilled.map((original, index) => [original.name, resolved[index] ?? original]))
  }

  async attendeeSuggestions(
    query: string,
    limit: number,
    lookupContacts: boolean,
  ): Promise<AttendeeSuggestions> {
    const { suggestions } = this.#deps
    const [notes, matches] = await Promise.all([
      suggestions.suggestWikiTargets(query, limit),
      lookupContacts ? this.#suggestContacts(query) : Promise.resolve([]),
    ])
    return {
      suggestions: notes.filter((suggestion) => suggestion.date === null),
      contacts: matches,
    }
  }

  async addMeetingToDaily(input: AddMeetingInput): Promise<AddMeetingOutcome> {
    const { noteFile, noteCreation, personNotes, graphSession } = this.#deps
    const { generation } = requireGraphSession(graphSession)
    const title = wikiLinkSafe(input.title)
    if (title === '') {
      throw new Error('a meeting needs a name')
    }
    const lookupContacts = input.lookupContacts ?? false

    const daily = dailyPath(input.date)
    const source = await this.#noteSource(daily, generation)
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
      await this.resolveAttendeeTargets(input.attendees, lookupContacts),
    ).filter(({ attendee }) => attendee.name.toLowerCase() !== title.toLowerCase())
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
    await noteFile.write(
      daily,
      appendListItem(source, { kind: 'bullet', markdown: line, section: MEETINGS_SECTION }),
      generation,
    )

    const createdNotes: string[] = []
    if (input.backlinkMeeting && !(await this.#titleHasNote(title))) {
      await noteCreation.createNoteWithTitle(title, generation, MEETING_NOTE_BODY)
      createdNotes.push(title)
    }
    for (const resolved of attendees) {
      if (resolved.kind !== 'new') {
        continue
      }
      const { attendee } = resolved
      const body = await this.#personNoteBody(attendee, lookupContacts)
      const outcome = await personNotes.ensurePersonNote({
        title: attendee.name,
        emails: attendee.emails ?? [],
        body,
        generation: generation,
      })
      if (outcome.kind === 'created') {
        createdNotes.push(attendee.name)
      }
    }

    return { appended: true, createdNotes }
  }

  /**
   * The contact rows of the attendee menu. A contacts hiccup costs only these
   * rows, never the note suggestions (the same containment as the editor's
   * `[[` menu), so a failure is logged and answers no contacts.
   */
  async #suggestContacts(query: string): Promise<ContactMatch[]> {
    const { contacts, logger } = this.#deps
    try {
      return await contacts.lookupPeople(query)
    } catch (error: unknown) {
      logger.error('contact link suggestions failed:', error)
      return []
    }
  }

  /**
   * A note's source at `generation`, where "no note yet" reads as empty.
   */
  async #noteSource(path: string, generation: number): Promise<string> {
    try {
      return await this.#deps.noteFile.read(path, generation)
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
  async #titleHasNote(title: string): Promise<boolean> {
    const { wikiResolver, noteFile } = this.#deps
    const resolution = await wikiResolver.resolveWikiTarget(title)
    if (resolution.kind === 'resolved') {
      return true
    }
    return await noteFile.exists(notePath(slugForTitle(title)))
  }

  /**
   * Look up an attendee email in Apple Contacts. A null answer is the expected
   * miss: the flow still creates a person note from the bare email.
   */
  async #attendeeContact(email: string): Promise<ContactMatch | null> {
    if (email.trim() === '') {
      return null
    }
    const candidates = await this.#deps.contacts.lookupByEmail(email.trim())
    return pickContactForEmail(email, candidates)
  }

  /**
   * The body a fresh person note is born with. Every resolved email is written.
   * When Contacts is readable, phone details from the same Contact are included
   * without adding emails that ownership resolution did not already inspect.
   */
  async #personNoteBody(attendee: MeetingAttendee, lookupContacts: boolean): Promise<string> {
    const emails = canonicalEmails(attendee.emails ?? [])
    if (lookupContacts && emails[0] !== undefined) {
      const contact = await this.#attendeeContact(emails[0])
      if (contact !== null) {
        const details = contactDetailsMarkdown({ ...contact, emails })
        if (details !== '') {
          return details
        }
      }
    }
    return [PERSON_NOTE_BODY, ...emails.map((email) => `- Email: ${email}`)].join('\n')
  }

  async #resolveMeetingAttendee(
    attendee: MeetingAttendee,
    lookupContacts: boolean,
  ): Promise<ResolvedMeetingAttendee> {
    const { personNotes } = this.#deps
    const emails = canonicalEmails(attendee.emails ?? [])
    let resolution = await personNotes.resolvePerson(emails)
    if (resolution.kind !== 'missing') {
      return targetFromPerson(attendee, resolution)
    }

    const nameEmail = canonicalEmail(attendee.name)
    if (lookupContacts && emails[0] !== undefined) {
      const contact = await this.#attendeeContact(emails[0])
      if (contact !== null) {
        const contactAttendee = {
          name:
            emails.includes(nameEmail) && contact.fullName.trim() !== ''
              ? contact.fullName.trim()
              : attendee.name,
          emails: canonicalEmails([...emails, ...contact.emails]),
        }
        resolution = await personNotes.resolvePerson(contactAttendee.emails)
        return targetFromPerson(contactAttendee, resolution)
      }
    }
    return targetFromPerson(normalizedAttendee(attendee, emails), resolution)
  }
}

export function createMeetingService(deps: MeetingServiceDeps): MeetingService {
  return new MeetingServiceImpl(deps)
}
