import { format, isSameDay, isSameWeek, parse } from 'date-fns'
import type { DateFormat, TimeFormat } from '@reflect/core'

/**
 * The app's date layer (Plan 06). Daily notes are keyed by **local** calendar
 * dates as ISO `YYYY-MM-DD` strings — "today" follows the user's clock. Pure
 * calendar arithmetic (`addDaysIso`, `isIsoDate`) lives in `@reflect/utils` and
 * is re-exported here; this module owns the date-fns-backed *display* formatting
 * and the local clock. Nothing else in the app may compute dates by hand.
 */

// Pure calendar math is shared with the indexing layer — one implementation.
export { addDaysIso, isIsoDate } from '@reflect/utils'

const ISO_DATE_FORMAT = 'yyyy-MM-dd'

/** Parse an ISO `YYYY-MM-DD` string as a local Date (the one parsing path). */
export function parseIsoDate(date: string): Date {
  return parse(date, ISO_DATE_FORMAT, new Date())
}

/** Today's local calendar date as `YYYY-MM-DD`. */
export function todayIso(): string {
  return format(new Date(), ISO_DATE_FORMAT)
}

/**
 * Label for an ISO date per the user's date-format setting. `mdy` and `dmy`
 * keep the original app's daily-subject form (`Tue, June 9th, 2026` /
 * `Tue, 9th June, 2026`); `iso` renders the daily-note key itself.
 */
export function formatDayLabel(date: string, dateFormat: DateFormat): string {
  switch (dateFormat) {
    case 'dmy':
      return format(parseIsoDate(date), 'EEE, do MMMM, yyyy')
    case 'iso':
      return date
    case 'mdy':
      return format(parseIsoDate(date), 'EEE, MMMM do, yyyy')
  }
}

/**
 * Compact date for inline chips (the Tasks view's `[[YYYY-MM-DD]]` due link,
 * V1's blue date): `12/31/2025` for `mdy`, `31/12/2025` for `dmy`, and
 * `2025-12-31` for `iso`.
 */
export function formatShortDate(date: string, dateFormat: DateFormat): string {
  switch (dateFormat) {
    case 'dmy':
      return format(parseIsoDate(date), 'd/M/yyyy')
    case 'iso':
      return date
    case 'mdy':
      return format(parseIsoDate(date), 'M/d/yyyy')
  }
}

/**
 * A date label per the date-format setting: `June 10th, 2026` for `mdy`,
 * `10th June, 2026` for `dmy`, and `2026-06-10` for `iso` (the forms the
 * settings screen shows as the options themselves).
 */
export function formatFullDate(date: Date, dateFormat: DateFormat): string {
  switch (dateFormat) {
    case 'dmy':
      return format(date, 'do MMMM, yyyy')
    case 'iso':
      return format(date, ISO_DATE_FORMAT)
    case 'mdy':
      return format(date, 'MMMM do, yyyy')
  }
}

/**
 * A time of day per the user's time-format setting: `8:22pm` for `12h`,
 * `20:22` for `24h`. Every time the app displays goes through this.
 */
export function formatTimeOfDay(date: Date, timeFormat: TimeFormat): string {
  return format(date, timeFormat === '24h' ? 'HH:mm' : 'h:mmaaa')
}

/**
 * The display-format preferences the date/time formatters need — a structural
 * subset of the settings document, so call sites can pass `settings` whole.
 */
export interface DateTimePrefs {
  timeFormat: TimeFormat
  dateFormat: DateFormat
}

/**
 * Compact recency label for list rows (the original app's Updated column):
 * the time for today (per `timeFormat`), the weekday within the current week
 * (`Mon`), the short date otherwise (`6/3/2026`, `3/6/2026`, or
 * `2026-06-03`). `now` is injectable for tests.
 */
export function formatRecencyLabel(
  epochMs: number,
  prefs: DateTimePrefs,
  now: Date = new Date(),
): string {
  const date = new Date(epochMs)
  if (isSameDay(date, now)) {
    return formatTimeOfDay(date, prefs.timeFormat)
  }
  if (isSameWeek(date, now)) {
    return format(date, 'EEE')
  }
  switch (prefs.dateFormat) {
    case 'dmy':
      return format(date, 'd/M/yyyy')
    case 'iso':
      return format(date, ISO_DATE_FORMAT)
    case 'mdy':
      return format(date, 'M/d/yyyy')
  }
}
