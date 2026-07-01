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

/**
 * The events worth showing for a day, in start order: drops all-day events,
 * canceled events, and events the user declined.
 */
export function displayEvents(events: CalendarEvent[]): CalendarEvent[] {
  return events
    .filter((event) => !event.allDay && !event.canceled && !isDeclinedByUser(event))
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
 * Attendee names to prefill the add-meeting dialog: human attendees who
 * haven't declined, excluding the user (a person note for yourself is noise).
 * Deduplicated case-insensitively, original order kept — the list is fully
 * editable in the dialog, so this is a starting point, not policy.
 */
export function defaultAttendeeNames(event: CalendarEvent): string[] {
  const seen = new Set<string>()
  const names: string[] = []
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
    names.push(name)
  }
  return names
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
