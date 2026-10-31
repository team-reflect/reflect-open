import type { MaybePromise } from '@reflect/utils'
import { z } from 'zod'
import type { LoggerService } from '../ports/logger-service.ts'
import { listenNow, type IpcBridgeService } from '../ipc/ipc-service.ts'
import type { Unlisten } from '../unlisten.ts'

/**
 * The Rust calendar capability (read-only EventKit,
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

export const calendarInfoSchema = z.object({
  /**
   * EventKit's stable calendar identifier: what `calendarIds` stores.
   */
  id: z.string(),
  title: z.string(),
  /**
   * The owning account's display name ("iCloud", "Google", "On My Mac").
   */
  source: z.string(),
  /**
   * Display color as `#rrggbb`, when the calendar has one.
   */
  color: z.string().nullable(),
})

export type CalendarInfo = z.infer<typeof calendarInfoSchema>

export const calendarAttendeeSchema = z.object({
  name: z.string(),
  /**
   * The invite email, when the participant URL carried one: what the
   * contacts integration resolves person notes by. `catch` because an
   * attendee without one must not fail the whole event list.
   */
  email: z.string().nullable().catch(null),
  isCurrentUser: z.boolean(),
  /**
   * People, as opposed to rooms and other booked resources.
   */
  isPerson: z.boolean(),
  status: z.enum(['accepted', 'declined', 'tentative', 'pending', 'unknown']),
})

export type CalendarAttendee = z.infer<typeof calendarAttendeeSchema>

export const calendarEventSchema = z.object({
  /**
   * EventKit's event identifier. Occurrences of a recurring event share one:
   * key list rows on `id` + `startsAt`.
   */
  id: z.string(),
  calendarId: z.string(),
  title: z.string(),
  /**
   * Start/end as Unix epoch milliseconds.
   */
  startsAt: z.number(),
  endsAt: z.number(),
  allDay: z.boolean(),
  recurring: z.boolean(),
  availability: z.enum(['busy', 'free', 'tentative', 'unavailable', 'notSupported']),
  canceled: z.boolean(),
  attendees: z.array(calendarAttendeeSchema),
})

export type CalendarEvent = z.infer<typeof calendarEventSchema>

/**
 * A time range as epoch milliseconds, `start` inclusive.
 */
export interface CalendarRange {
  start: number
  end: number
}

/**
 * Live reads of the OS calendar database.
 */
export interface CalendarService {
  /**
   * The current calendar permission state. Never prompts.
   */
  authorizationStatus(): MaybePromise<CalendarAuthorizationStatus>
  /**
   * Trigger the OS calendar permission prompt and resolve with whether full
   * access was granted. The OS prompts once; after a denial this resolves
   * `false` at once and the user must change the switch in System Settings.
   */
  requestAccess(): MaybePromise<boolean>
  /**
   * Every event calendar, across all accounts.
   */
  listCalendars(): MaybePromise<CalendarInfo[]>
  /**
   * Events from `calendarIds` overlapping `range`, unfiltered (display
   * policy is `displayEvents`). Unknown calendar identifiers are skipped,
   * so a removed account degrades to fewer events.
   */
  listEvents(range: CalendarRange, calendarIds: readonly string[]): MaybePromise<CalendarEvent[]>
  /**
   * Call `listener` whenever anything in the calendar database changes. The
   * notification carries nothing; re-query for the new state.
   */
  subscribeChanged(listener: () => void): Unlisten
}

const CHANGED_EVENT = 'calendar:changed'

export interface CalendarServiceDeps {
  readonly ipc: IpcBridgeService
  readonly logger: LoggerService
}

class CalendarServiceImpl implements CalendarService {
  readonly #deps: CalendarServiceDeps

  constructor(deps: CalendarServiceDeps) {
    this.#deps = deps
  }

  authorizationStatus(): Promise<CalendarAuthorizationStatus> {
    return this.#deps.ipc.call(
      'calendar_authorization_status',
      {},
      calendarAuthorizationStatusSchema,
    )
  }

  requestAccess(): Promise<boolean> {
    return this.#deps.ipc.call('calendar_request_access', {}, z.boolean())
  }

  listCalendars(): Promise<CalendarInfo[]> {
    return this.#deps.ipc.call('calendar_list_calendars', {}, z.array(calendarInfoSchema))
  }

  listEvents(range: CalendarRange, calendarIds: readonly string[]): Promise<CalendarEvent[]> {
    return this.#deps.ipc.call(
      'calendar_list_events',
      { start: range.start, end: range.end, calendarIds: [...calendarIds] },
      z.array(calendarEventSchema),
    )
  }

  subscribeChanged(listener: () => void): Unlisten {
    const { ipc, logger } = this.#deps
    return listenNow(
      () => {
        return ipc.listen(CHANGED_EVENT, () => {
          listener()
        })
      },
      (cause) => {
        logger.warn(`failed to listen for "${CHANGED_EVENT}"`, cause)
      },
    )
  }
}

export function createCalendarService(deps: CalendarServiceDeps): CalendarService {
  return new CalendarServiceImpl(deps)
}
