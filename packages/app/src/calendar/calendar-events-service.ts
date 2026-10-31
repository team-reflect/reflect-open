import {
  dayRange,
  type CalendarAuthorizationStatus,
  type CalendarEvent,
  type CalendarInfo,
  type CalendarService,
  type LoggerService,
  type PlatformFacts,
  type Settings,
  type SettingsService,
  type Unlisten,
} from '@reflect/core'
import type { AppLifecycleService } from '../app/lifecycle-service.ts'

/**
 * What a {@link CalendarEventsService} knows of the calendar permission.
 */
export interface CalendarEventsState {
  /**
   * The macOS calendar permission state; `null` until the first read.
   */
  readonly authorization: CalendarAuthorizationStatus | null
}

/**
 * The calendar integration behind the daily note's events panel and the
 * settings field (docs/porting/calendar-meetings-integration.md). Events are
 * fetched live: nothing here is cached, and nothing is indexed.
 */
export interface CalendarEventsService {
  getState: () => CalendarEventsState
  /**
   * Called after the state changes.
   */
  subscribe: (listener: () => void) => Unlisten
  /**
   * Read the permission state now, again whenever the page turns visible or
   * the calendar reports a change, until the returned function runs. The
   * state changes behind Reflect's back in System Settings. Never prompts.
   */
  watchAuthorization(): Unlisten
  /**
   * Whether calendar reads can run at all: the macOS desktop shell only.
   */
  isAvailable(): boolean
  /**
   * Every calendar on the Mac, for the settings chooser.
   */
  listCalendars(): Promise<CalendarInfo[]>
  /**
   * The raw events of the local day `date` (ISO `YYYY-MM-DD`) from
   * `calendarIds`. Display policy is `displayEvents`.
   */
  listDayEvents(date: string, calendarIds: readonly string[]): Promise<CalendarEvent[]>
  /**
   * Call `listener` when EventKit reports a change (an edit in Calendar.app,
   * an account sync, a permission flip): live reads instead of v1's
   * ten-minute poll.
   */
  subscribeChanged(listener: () => void): Unlisten
  /**
   * Ask the OS for calendar access, then re-read the permission state.
   * Resolves instantly when the OS already remembers an answer; prompts only
   * on the very first request. Never rejects: a failure is logged, and the
   * permission state is the truth.
   */
  requestAccess(): Promise<void>
  /**
   * Switch the integration on or off. Switching it on also requests access;
   * `accessRequested` then tells the caller to re-read the calendars.
   */
  setEnabled(enabled: boolean): Promise<{ accessRequested: boolean }>
  /**
   * Add `id` to, or remove it from, the calendars the daily note shows.
   */
  toggleCalendar(id: string, checked: boolean): void
}

/**
 * Does the daily note show events under `settings`? The integration is on and
 * at least one calendar is chosen.
 */
export function showsDayEvents(
  settings: Pick<Settings, 'calendarEnabled' | 'calendarIds'>,
): boolean {
  return settings.calendarEnabled && settings.calendarIds.length > 0
}

/**
 * `calendars` grouped by their account, groups and members in first-seen order.
 */
export function groupCalendarsBySource(
  calendars: readonly CalendarInfo[],
): Array<[source: string, calendars: CalendarInfo[]]> {
  const bySource = new Map<string, CalendarInfo[]>()
  for (const calendar of calendars) {
    const group = bySource.get(calendar.source)
    if (group) {
      group.push(calendar)
    } else {
      bySource.set(calendar.source, [calendar])
    }
  }
  return [...bySource]
}

/**
 * How many of `calendars` are chosen. Counts only ids the Mac still knows:
 * settings may hold identifiers from since-removed accounts, and "3/2
 * calendars" would be nonsense.
 */
export function countSelectedCalendars(
  calendars: readonly CalendarInfo[],
  calendarIds: readonly string[],
): number {
  return calendars.filter((calendar) => calendarIds.includes(calendar.id)).length
}

export interface CalendarEventsServiceDeps {
  readonly calendar: CalendarService
  readonly settings: SettingsService
  readonly platform: PlatformFacts
  readonly lifecycle: AppLifecycleService
  readonly logger: LoggerService
}

class CalendarEventsServiceImpl implements CalendarEventsService {
  readonly #deps: CalendarEventsServiceDeps
  readonly #listeners = new Set<() => void>()
  #state: CalendarEventsState = { authorization: null }
  // Bumped by every read, so only the latest one publishes.
  #reads = 0

  constructor(deps: CalendarEventsServiceDeps) {
    this.#deps = deps
  }

  readonly getState = (): CalendarEventsState => this.#state

  readonly subscribe = (listener: () => void): Unlisten => {
    const deliver = (): void => {
      listener()
    }
    this.#listeners.add(deliver)
    return () => {
      this.#listeners.delete(deliver)
    }
  }

  watchAuthorization(): Unlisten {
    const { calendar, lifecycle } = this.#deps
    void this.#refreshAuthorization()
    const stopVisible = lifecycle.subscribeVisible(() => {
      void this.#refreshAuthorization()
    })
    const stopChanged = calendar.subscribeChanged(() => {
      void this.#refreshAuthorization()
    })
    return () => {
      stopVisible()
      stopChanged()
    }
  }

  isAvailable(): boolean {
    return this.#deps.platform.isMacosDesktop
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    return await this.#deps.calendar.listCalendars()
  }

  async listDayEvents(date: string, calendarIds: readonly string[]): Promise<CalendarEvent[]> {
    return await this.#deps.calendar.listEvents(dayRange(date), calendarIds)
  }

  subscribeChanged(listener: () => void): Unlisten {
    return this.#deps.calendar.subscribeChanged(listener)
  }

  async requestAccess(): Promise<void> {
    try {
      await this.#deps.calendar.requestAccess()
    } catch (cause) {
      this.#deps.logger.error('calendar access request failed:', cause)
    }
    await this.#refreshAuthorization()
  }

  async setEnabled(enabled: boolean): Promise<{ accessRequested: boolean }> {
    this.#deps.settings.update({ calendarEnabled: enabled })
    if (!enabled) {
      return { accessRequested: false }
    }
    await this.requestAccess()
    return { accessRequested: true }
  }

  toggleCalendar(id: string, checked: boolean): void {
    this.#deps.settings.updateWith((current) => ({
      calendarIds: checked
        ? [...current.calendarIds.filter((existing) => existing !== id), id]
        : current.calendarIds.filter((existing) => existing !== id),
    }))
  }

  async #refreshAuthorization(): Promise<void> {
    this.#reads += 1
    const read = this.#reads
    let authorization: CalendarAuthorizationStatus
    try {
      authorization = await this.#deps.calendar.authorizationStatus()
    } catch (cause) {
      this.#deps.logger.error('calendar authorization read failed:', cause)
      return
    }
    if (read !== this.#reads || authorization === this.#state.authorization) {
      return
    }
    this.#state = { authorization }
    for (const listener of this.#listeners) {
      listener()
    }
  }
}

export function createCalendarEventsService(
  deps: CalendarEventsServiceDeps,
): CalendarEventsService {
  return new CalendarEventsServiceImpl(deps)
}
