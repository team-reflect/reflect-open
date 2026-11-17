import type { DailyNoteRow } from '@reflect/types'
import type { ClockService } from '../ports/clock-service.ts'
import type { ActivityPort } from '../ports/activity-port.ts'
import type { DatabaseService } from '../indexing/database-service.ts'
import type { Unlisten } from '../unlisten.ts'
import { formatIsoDate } from '@reflect/utils'

export interface DailyNotesRange {
  /**
   * First day, inclusive (ISO `YYYY-MM-DD`).
   */
  start: string
  /**
   * Last day, inclusive (ISO `YYYY-MM-DD`).
   */
  end: string
  /**
   * Row cap — the most recent days in range win.
   */
  limit: number
}

export interface DailyNoteServiceDeps {
  readonly database: DatabaseService
  readonly clock: ClockService
  readonly activity: ActivityPort
}

/**
 * The date questions about notes: which days have a daily note, and the wake
 * onto a new day.
 */
export interface DailyNoteService {
  /**
   * ISO dates within `[start, end]` (inclusive) whose daily note has content,
   * ascending: the calendar's day markers.
   */
  dailyDatesInRange(start: string, end: string): Promise<string[]>
  /**
   * Daily notes within `[start, end]` (inclusive), most recent first, capped at
   * `limit`. Daily files are created lazily on first write, so a row means the
   * day has real content. Private dailies are excluded in SQL so they don't
   * consume cap slots — the AI privacy gate still re-checks every row live.
   */
  listDailyNotes(range: DailyNotesRange): Promise<DailyNoteRow[]>
  /**
   * V1's wake-to-today: calls `listener` with the new date when the app
   * returns to the foreground on a later calendar date than it was last seen
   * on. An app left open across midnight rolls over through
   * `TodayService` instead, so this only reports the backgrounded case. The
   * caller navigates; this service does not.
   *
   * The date is read from the wall clock (`now()`) at each visibility change,
   * not from `TodayService`: it refreshes its cached date on the same
   * visibility event, and listener order must not decide the result.
   */
  subscribeWakeOnNewDay(listener: (today: string) => void): Unlisten
}

class DailyNoteServiceImpl implements DailyNoteService {
  readonly #deps: DailyNoteServiceDeps

  constructor(deps: DailyNoteServiceDeps) {
    this.#deps = deps
  }

  async dailyDatesInRange(start: string, end: string): Promise<string[]> {
    return await this.#deps.database.read('index_daily_dates', { start, end })
  }

  async listDailyNotes(range: DailyNotesRange): Promise<DailyNoteRow[]> {
    return await this.#deps.database.read('index_daily_notes', range)
  }

  subscribeWakeOnNewDay(listener: (today: string) => void): Unlisten {
    const { activity } = this.#deps
    let lastSeen = this.#wallDate()
    const removeHidden = activity.subscribeHidden(() => {
      lastSeen = this.#wallDate()
    })
    const removeVisible = activity.subscribeVisible(() => {
      const now = this.#wallDate()
      if (now !== lastSeen) {
        lastSeen = now
        listener(now)
      }
    })
    return () => {
      removeHidden()
      removeVisible()
    }
  }

  #wallDate(): string {
    return formatIsoDate(new Date(this.#deps.clock.now()))
  }
}

export function createDailyNoteService(deps: DailyNoteServiceDeps): DailyNoteService {
  return new DailyNoteServiceImpl(deps)
}
