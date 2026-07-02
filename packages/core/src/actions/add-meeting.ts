import { isAppError } from '../errors'
import { noteExists, readNote, writeNote } from '../graph/commands'
import { dailyPath, notePath } from '../graph/paths'
import { resolveWikiTarget } from '../indexing/queries'
import { appendUnderHeading, wikiLinkSafe } from '../markdown/edit'
import { parseNote } from '../markdown/extract'
import { foldKey } from '../markdown/keys'
import { slugForTitle } from '../markdown/slug'

/**
 * "Add to daily note" for a calendar event — the write half of the calendar
 * integration (docs/porting/calendar-meetings-integration.md). Submitting the
 * add-meeting dialog appends one bullet under the daily note's `## Meetings`
 * heading — a `[[Meeting]]` link plus a `[[Person]]` link per attendee — and
 * creates the notes those links resolve to when they don't exist yet. After
 * that, they are ordinary notes; nothing stays tied to the calendar, and no
 * event metadata is persisted beyond this markdown.
 *
 * Wiki links resolve by title, so "one note per meeting title" holds by
 * construction: a recurring "Standup" links the same `[[Standup]]` note from
 * every day it's added.
 */

/** Where the daily-note entry lands (`appendUnderHeading` creates it). */
export const MEETINGS_HEADING = 'Meetings'

/** Person notes are typed like v1 tagged them — the All Notes "person" filter. */
const PERSON_NOTE_BODY = '- Type: #person'

export interface AddMeetingInput {
  /** ISO `YYYY-MM-DD` day of the daily note receiving the entry. */
  date: string
  /** Meeting name — becomes the `[[Meeting]]` link text and note title. */
  title: string
  /** Attendee names — each becomes a `[[Person]]` link and (maybe) a note. */
  attendees: string[]
  /**
   * Whether to create the meeting note now. Off still writes the `[[link]]` —
   * unresolved links create their note on first click, so nothing breaks.
   */
  createMeetingNote: boolean
  /** `GraphInfo.generation` — pins every read and write to the issuing graph. */
  generation: number
  /**
   * Creates a note titled `title` (optional extra body under the H1) and
   * returns its graph-relative path. Injected because note identity (the
   * frontmatter `id` ULID) is minted by the host app — the desktop passes
   * `createNoteWithTitle`.
   */
  createNote: (title: string, generation: number, body?: string) => Promise<string>
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
  return wikiLinks.some(
    (link) =>
      link.from >= heading.to && link.from < sectionEnd && foldKey(link.target) === titleKey,
  )
}

/** Sanitized, case-insensitively deduplicated attendee names, order kept. */
function normalizeAttendees(attendees: string[]): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const attendee of attendees) {
    const name = wikiLinkSafe(attendee)
    const key = name.toLowerCase()
    if (name === '' || seen.has(key)) {
      continue
    }
    seen.add(key)
    names.push(name)
  }
  return names
}

/** The daily-note bullet: `- [[Meeting]] with [[Alice]], [[Bob]]`. */
export function meetingLine(title: string, attendees: string[]): string {
  const link = `[[${title}]]`
  if (attendees.length === 0) {
    return `- ${link}`
  }
  const links = attendees.map((name) => `[[${name}]]`).join(', ')
  return `- ${link} with ${links}`
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
  // An attendee spelled like the meeting itself (a shared mailbox, a 1:1
  // named after the person) would just duplicate the link — drop it.
  const attendees = normalizeAttendees(input.attendees).filter(
    (name) => name.toLowerCase() !== title.toLowerCase(),
  )

  const daily = dailyPath(input.date)
  const source = await noteSource(daily, input.generation)
  const alreadyLinked = meetingAlreadyLinked(source, title)
  if (!alreadyLinked) {
    await writeNote(
      daily,
      appendUnderHeading(source, MEETINGS_HEADING, meetingLine(title, attendees)),
      input.generation,
    )
  }

  const createdNotes: string[] = []
  if (input.createMeetingNote && !(await titleHasNote(title))) {
    await input.createNote(title, input.generation)
    createdNotes.push(title)
  }
  for (const name of attendees) {
    if (await titleHasNote(name)) {
      continue
    }
    await input.createNote(name, input.generation, PERSON_NOTE_BODY)
    createdNotes.push(name)
  }

  return { appended: !alreadyLinked, createdNotes }
}
