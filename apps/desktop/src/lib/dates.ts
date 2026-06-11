import { addDays, format, isSameDay, isSameWeek, isValid, parse } from 'date-fns'
import type { DateFormat, TimeFormat } from '@reflect/core'

/**
 * The one date module (Plan 06). Daily notes are keyed by **local** calendar
 * dates as ISO `YYYY-MM-DD` strings — "today" follows the user's clock, and all
 * arithmetic round-trips through date-fns so DST transitions can't skip or
 * repeat a day. Nothing else in the app may compute dates by hand.
 */

const ISO_DATE_FORMAT = 'yyyy-MM-dd'

/** Parse an ISO `YYYY-MM-DD` string as a local Date (the one parsing path). */
export function parseIsoDate(date: string): Date {
  return parse(date, ISO_DATE_FORMAT, new Date())
}

/** Today's local calendar date as `YYYY-MM-DD`. */
export function todayIso(): string {
  return format(new Date(), ISO_DATE_FORMAT)
}

/** Is `value` a real calendar date in ISO `YYYY-MM-DD` form? */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }
  return isValid(parseIsoDate(value))
}

/** The ISO date `days` after `date` (negative for before). DST-safe. */
export function addDaysIso(date: string, days: number): string {
  return format(addDays(parseIsoDate(date), days), ISO_DATE_FORMAT)
}

/**
 * Human label for an ISO date per the user's date-format setting, in the
 * original app's daily-subject form: `Tue, June 9th, 2026` for `mdy`
 * (V1's `weekMonthDayYear`), `Tue, 9th June, 2026` for `dmy`
 * (V1's `weekDayMonthYear`).
 */
export function formatDayLabel(date: string, dateFormat: DateFormat): string {
  return format(
    parseIsoDate(date),
    dateFormat === 'dmy' ? 'EEE, do MMMM, yyyy' : 'EEE, MMMM do, yyyy',
  )
}

/**
 * A date spelled out in full per the date-format setting: `June 10th, 2026`
 * for `mdy`, `10th June, 2026` for `dmy` (the forms the settings screen shows
 * as the options themselves).
 */
export function formatFullDate(date: Date, dateFormat: DateFormat): string {
  return format(date, dateFormat === 'dmy' ? 'do MMMM, yyyy' : 'MMMM do, yyyy')
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
 * (`Mon`), the short date otherwise (`6/3/2026`, or `3/6/2026` for `dmy`).
 * `now` is injectable for tests.
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
  return format(date, prefs.dateFormat === 'dmy' ? 'd/M/yyyy' : 'M/d/yyyy')
}
