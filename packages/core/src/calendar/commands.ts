import { z } from 'zod'
import { getBridge, type Unlisten } from '../ipc/bridge'
import { call } from '../ipc/invoke'

/**
 * Typed bindings for the Rust calendar capability (read-only EventKit —
 * `apps/desktop/src-tauri/src/calendar.rs`). Events are fetched live and
 * never persisted: nothing here touches the index, and no calendar data
 * leaves the machine (docs/porting/calendar-meetings-integration.md).
 */

export const calendarAuthorizationStatusSchema = z.enum([
  'notDetermined',
  'restricted',
  'denied',
  'fullAccess',
  'writeOnly',
])

/**
 * The macOS calendar permission state. Only `fullAccess` lets Reflect read
 * events; `writeOnly` exists in the OS vocabulary but is useless to a
 * read-only integration and renders as "no access".
 */
export type CalendarAuthorizationStatus = z.infer<typeof calendarAuthorizationStatusSchema>

/** True when events can actually be read under `status`. */
export function canReadCalendars(status: CalendarAuthorizationStatus): boolean {
  return status === 'fullAccess'
}

export const calendarInfoSchema = z.object({
  /** EventKit's stable calendar identifier — what `calendarIds` stores. */
  id: z.string(),
  title: z.string(),
  /** The owning account's display name ("iCloud", "Google", "On My Mac"). */
  source: z.string(),
  /** Display color as `#rrggbb`, when the calendar has one. */
  color: z.string().nullable(),
})

export type CalendarInfo = z.infer<typeof calendarInfoSchema>

export const calendarAttendeeSchema = z.object({
  name: z.string(),
  /**
   * The invite email, when the participant URL carried one — what the
   * contacts integration resolves person notes by. `catch` because an
   * attendee without one must not fail the whole event list.
   */
  email: z.string().nullable().catch(null),
  isCurrentUser: z.boolean(),
  /** People, as opposed to rooms and other booked resources. */
  isPerson: z.boolean(),
  status: z.enum(['accepted', 'declined', 'tentative', 'pending', 'unknown']),
})

export type CalendarAttendee = z.infer<typeof calendarAttendeeSchema>

export const calendarEventSchema = z.object({
  /**
   * EventKit's event identifier. Occurrences of a recurring event share one —
   * key list rows on `id` + `startsAt`.
   */
  id: z.string(),
  calendarId: z.string(),
  title: z.string(),
  /** Start/end as Unix epoch milliseconds. */
  startsAt: z.number(),
  endsAt: z.number(),
  allDay: z.boolean(),
  recurring: z.boolean(),
  availability: z.enum(['busy', 'free', 'tentative', 'unavailable', 'notSupported']),
  canceled: z.boolean(),
  attendees: z.array(calendarAttendeeSchema),
})

export type CalendarEvent = z.infer<typeof calendarEventSchema>

/** The current calendar permission state (never prompts). */
export async function calendarAuthorizationStatus(): Promise<CalendarAuthorizationStatus> {
  return call('calendar_authorization_status', {}, calendarAuthorizationStatusSchema)
}

/**
 * Trigger the macOS calendar permission prompt and resolve with whether full
 * access was granted. The OS only ever prompts once — after a denial this
 * resolves `false` immediately, and the user must flip the switch in
 * System Settings → Privacy & Security → Calendars instead.
 */
export async function requestCalendarAccess(): Promise<boolean> {
  return call('calendar_request_access', {}, z.boolean())
}

/** Every event calendar on this Mac, across all accounts. */
export async function listCalendars(): Promise<CalendarInfo[]> {
  return call('calendar_list_calendars', {}, z.array(calendarInfoSchema))
}

/**
 * Events from `calendarIds` overlapping `[start, end]` (epoch milliseconds),
 * unfiltered — display policy (declined, all-day) is `displayEvents` in
 * `./events`. Unknown calendar identifiers are skipped, not errors, so a
 * removed account degrades to fewer events.
 */
export async function listCalendarEvents(
  start: number,
  end: number,
  calendarIds: string[],
): Promise<CalendarEvent[]> {
  return call('calendar_list_events', { start, end, calendarIds }, z.array(calendarEventSchema))
}

/**
 * Subscribe to EventKit change notifications (`calendar:changed`), fired when
 * anything in the calendar database changes — consumers refetch instead of
 * polling. The payload carries nothing; re-query for the new state.
 */
export function subscribeCalendarChanged(handler: () => void): Promise<Unlisten> {
  return getBridge().listen('calendar:changed', () => {
    handler()
  })
}
