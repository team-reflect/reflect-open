import type { MeetingAttendee } from '../actions/add-meeting'
import type { CalendarAttendee, CalendarEvent } from './commands'

/**
 * Display policy for the daily-note events panel — the TypeScript half of the
 * calendar integration (the Rust side reports events verbatim). Mirrors v1:
 * meetings the user declined and all-day placeholders (OOO banners, holidays)
 * don't belong beside the daily note.
 */

/** Did the current user decline this event? */
export function isDeclinedByUser(event: CalendarEvent): boolean {
  return event.attendees.some((attendee) => attendee.isCurrentUser && attendee.status === 'declined')
}

/** Calendar-blocking placeholders v1 filtered by name, case-insensitively. */
const PLACEHOLDER_NAMES = new Set(['block', 'busy'])

/** Is this a real meeting, not a placeholder? (v1's `isValidMeeting`.) */
function isDisplayableEvent(event: CalendarEvent): boolean {
  const name = event.title.trim().toLowerCase()
  if (name === '' || PLACEHOLDER_NAMES.has(name)) {
    return false
  }
  return !event.allDay && !event.canceled && !isDeclinedByUser(event)
}

/**
 * The events worth showing for a day, in start order — v1's display rules:
 * drops all-day events, canceled events, events the user declined, untitled
 * events, and busy-block placeholders; an event on two enabled calendars
 * shows once.
 */
export function displayEvents(events: CalendarEvent[]): CalendarEvent[] {
  const seen = new Set<string>()
  return events
    .filter((event) => {
      if (!isDisplayableEvent(event)) {
        return false
      }
      const key = `${event.id}:${event.startsAt}`
      if (seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })
    .sort((first, second) => first.startsAt - second.startsAt || first.title.localeCompare(second.title))
}

/** Is `attendee` someone to suggest a person note for? */
function isSuggestedAttendee(attendee: CalendarAttendee): boolean {
  return (
    attendee.isPerson &&
    !attendee.isCurrentUser &&
    attendee.status !== 'declined' &&
    attendee.name.trim() !== ''
  )
}

/**
 * Attendees to prefill the add-meeting dialog: human attendees who haven't
 * declined, excluding the user (a person note for yourself is noise), each
 * carrying the invite email the contacts integration resolves by.
 * Deduplicated case-insensitively by name, original order kept — the list is
 * fully editable in the dialog, so this is a starting point, not policy.
 */
export function defaultAttendees(event: CalendarEvent): MeetingAttendee[] {
  const seen = new Set<string>()
  const attendees: MeetingAttendee[] = []
  for (const attendee of event.attendees) {
    if (!isSuggestedAttendee(attendee)) {
      continue
    }
    const name = attendee.name.trim()
    const key = name.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    attendees.push(attendee.email === null ? { name } : { name, email: attendee.email })
  }
  return attendees
}

/**
 * The local-time query range for one ISO `YYYY-MM-DD` day, as epoch
 * milliseconds — midnight to the following midnight, in the machine's zone
 * (EventKit predicates work in absolute time).
 */
export function dayRange(date: string): { start: number; end: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (match === null) {
    throw new Error(`dayRange expects an ISO YYYY-MM-DD date, got: ${date}`)
  }
  const [, year, month, day] = match
  const start = new Date(Number(year), Number(month) - 1, Number(day))
  const end = new Date(Number(year), Number(month) - 1, Number(day) + 1)
  return { start: start.getTime(), end: end.getTime() }
}
