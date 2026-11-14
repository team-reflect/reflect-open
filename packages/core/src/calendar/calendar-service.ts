import type { MaybePromise } from '@reflect/utils'
import type {
  CalendarAttendee,
  CalendarAuthorizationStatus,
  CalendarEvent,
  CalendarInfo,
} from '@reflect/types'
import type { LoggerService } from '../ports/logger-service.ts'
import { listenNow, type IpcBridgeService } from '../ipc/ipc-service.ts'
import type { Unlisten } from '../unlisten.ts'

export type { CalendarAttendee, CalendarAuthorizationStatus, CalendarEvent, CalendarInfo }

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
    return this.#deps.ipc.call('calendar_authorization_status', {})
  }

  requestAccess(): Promise<boolean> {
    return this.#deps.ipc.call('calendar_request_access', {})
  }

  listCalendars(): Promise<CalendarInfo[]> {
    return this.#deps.ipc.call('calendar_list_calendars', {})
  }

  listEvents(range: CalendarRange, calendarIds: readonly string[]): Promise<CalendarEvent[]> {
    return this.#deps.ipc.call('calendar_list_events', {
      start: range.start,
      end: range.end,
      calendarIds,
    })
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
