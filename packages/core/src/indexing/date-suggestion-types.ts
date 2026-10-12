import type { DateFormat, WeekStartDay } from '../settings/schema.ts'

/** One synthesised daily-note target: the resolved day plus its menu label. */
export interface DateSuggestion {
  /** Resolved daily-note date, ISO `YYYY-MM-DD`. */
  date: string
  /** Human label for the menu ("3 days ago", "Next Friday"); `null` for a bare ISO query. */
  phrase: string | null
}

/** What the generator needs from its caller: the local clock and display preferences. */
export interface DateSuggestionContext {
  /** Today's local calendar date, ISO `YYYY-MM-DD`. */
  today: string
  /**
   * Reading order for ambiguous typed slash-dates (`mdy` → M/D, `dmy` → D/M).
   * `iso` has no slash-date order, so it keeps the default M/D reading.
   */
  dateFormat: DateFormat
  /** Which day "this/next/last week" (and weekend) anchor to. */
  weekStartDay: WeekStartDay
}
