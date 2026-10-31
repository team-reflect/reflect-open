import type { CalendarAuthorizationStatus } from './calendar-service.ts'

/**
 * The calendar permission policy. The capability's shapes and reads are
 * `CalendarService`.
 */

/** True when events can actually be read under `status`. */
export function canReadCalendars(status: CalendarAuthorizationStatus): boolean {
  return status === 'fullAccess'
}
