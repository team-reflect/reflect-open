import type {
  CalendarAuthorizationStatus,
  CalendarEvent,
  CalendarInfo,
  CalendarRange,
  CalendarService,
} from '../calendar/calendar-service.ts'
import type { Unlisten } from '../unlisten.ts'

export interface TestCalendarServiceOptions {
  /**
   * The permission state. Defaults to `fullAccess`.
   */
  status?: CalendarAuthorizationStatus
  /**
   * Whether the permission prompt grants access. Defaults to `true`.
   */
  grantAccess?: boolean
  calendars?: readonly CalendarInfo[]
  events?: readonly CalendarEvent[]
}

export interface TestCalendarService extends CalendarService {
  setStatus(status: CalendarAuthorizationStatus): void
  setCalendars(calendars: readonly CalendarInfo[]): void
  setEvents(events: readonly CalendarEvent[]): void
  /**
   * Notify every `subscribeChanged` listener.
   */
  emitChanged(): void
  /**
   * How many times `requestAccess` ran.
   */
  accessRequests(): number
}

class TestCalendarServiceImpl implements TestCalendarService {
  readonly #grantAccess: boolean
  readonly #listeners = new Set<() => void>()
  #status: CalendarAuthorizationStatus
  #calendars: CalendarInfo[]
  #events: CalendarEvent[]
  #requests = 0

  constructor(options?: TestCalendarServiceOptions) {
    this.#status = options?.status ?? 'fullAccess'
    this.#calendars = [...(options?.calendars ?? [])]
    this.#events = [...(options?.events ?? [])]
    this.#grantAccess = options?.grantAccess ?? true
  }

  authorizationStatus(): CalendarAuthorizationStatus {
    return this.#status
  }

  requestAccess(): boolean {
    this.#requests++
    if (this.#status === 'notDetermined') {
      this.#status = this.#grantAccess ? 'fullAccess' : 'denied'
    }
    return this.#status === 'fullAccess'
  }

  listCalendars(): CalendarInfo[] {
    return [...this.#calendars]
  }

  async listEvents(range: CalendarRange, calendarIds: readonly string[]): Promise<CalendarEvent[]> {
    return this.#events.filter(
      (event) =>
        calendarIds.includes(event.calendarId) &&
        event.startsAt <= range.end &&
        event.endsAt >= range.start,
    )
  }

  subscribeChanged(listener: () => void): Unlisten {
    // Wrapped for identity, so one function added twice detaches independently.
    const deliver = (): void => {
      listener()
    }
    this.#listeners.add(deliver)
    return () => {
      this.#listeners.delete(deliver)
    }
  }

  setStatus(next: CalendarAuthorizationStatus): void {
    this.#status = next
  }

  setCalendars(next: readonly CalendarInfo[]): void {
    this.#calendars = [...next]
  }

  setEvents(next: readonly CalendarEvent[]): void {
    this.#events = [...next]
  }

  emitChanged(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }

  accessRequests(): number {
    return this.#requests
  }
}

/**
 * An in-memory {@link CalendarService}. `listEvents` answers the events on
 * the asked calendars that overlap the range. Like the OS, `requestAccess`
 * prompts only while the status is `notDetermined`.
 */
export function createTestCalendarService(
  options?: TestCalendarServiceOptions,
): TestCalendarService {
  return new TestCalendarServiceImpl(options)
}
