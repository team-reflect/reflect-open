import { format, formatDistanceToNow, isSameDay, isSameWeek } from 'date-fns'
import {
  addDaysIso,
  isIsoDate,
  monthStartIso,
  parseIsoDate,
  startOfWeekIso,
  todayIso,
  type WeekStartDay,
} from './dates.ts'

/** The date-format setting's choices. */
export const DATE_FORMATS = ['mdy', 'dmy', 'iso'] as const

export type DateFormat = (typeof DATE_FORMATS)[number]

/** The time-format setting's choices. */
export const TIME_FORMATS = ['12h', '24h'] as const

export type TimeFormat = (typeof TIME_FORMATS)[number]

/**
 * The display-format preferences the date/time formatters need — a structural
 * subset of the settings document, so call sites can pass `settings` whole.
 */
export interface DateTimePrefs {
  timeFormat: TimeFormat
  dateFormat: DateFormat
}

/**
 * Render `date` with the date-fns pattern of the chosen format, or as ISO
 * `YYYY-MM-DD` for `iso`.
 */
function formatByDateFormat(
  date: Date,
  dateFormat: DateFormat,
  patterns: Record<Exclude<DateFormat, 'iso'>, string>,
): string {
  return format(date, dateFormat === 'iso' ? 'yyyy-MM-dd' : patterns[dateFormat])
}

/**
 * Render an ISO date per the chosen format. A date-shaped string that names no
 * real day (a file called `daily/2026-13-45.md`) renders as itself.
 */
function formatIsoByDateFormat(
  date: string,
  dateFormat: DateFormat,
  patterns: Record<Exclude<DateFormat, 'iso'>, string>,
): string {
  return isIsoDate(date) ? formatByDateFormat(parseIsoDate(date), dateFormat, patterns) : date
}

/**
 * Label for an ISO date per the user's date-format setting. `mdy` and `dmy`
 * keep the original app's daily-subject form (`Tue, June 9th, 2026` /
 * `Tue, 9th June, 2026`); `iso` renders the daily-note key itself.
 */
export function formatDayLabel(date: string, dateFormat: DateFormat): string {
  return formatIsoByDateFormat(date, dateFormat, {
    dmy: 'EEE, do MMMM, yyyy',
    mdy: 'EEE, MMMM do, yyyy',
  })
}

const SHORT_DATE_PATTERNS = { dmy: 'd/M/yyyy', mdy: 'M/d/yyyy' }

/**
 * Compact date for inline chips (the Tasks view's `[[YYYY-MM-DD]]` due link,
 * V1's blue date): `12/31/2025` for `mdy`, `31/12/2025` for `dmy`, and
 * `2025-12-31` for `iso`.
 */
export function formatShortDate(date: string, dateFormat: DateFormat): string {
  return formatIsoByDateFormat(date, dateFormat, SHORT_DATE_PATTERNS)
}

/**
 * Month and day without the year, for labels short on room (a filter chip's
 * range): `Jun 9` for `mdy`, `9 Jun` for `dmy`, and `2026-06-09` for `iso`.
 */
export function formatMonthDay(date: string, dateFormat: DateFormat): string {
  return formatIsoByDateFormat(date, dateFormat, { dmy: 'd MMM', mdy: 'MMM d' })
}

/**
 * A date label per the date-format setting: `June 10th, 2026` for `mdy`,
 * `10th June, 2026` for `dmy`, and `2026-06-10` for `iso` (the forms the
 * settings screen shows as the options themselves).
 */
export function formatFullDate(date: Date, dateFormat: DateFormat): string {
  return formatByDateFormat(date, dateFormat, { dmy: 'do MMMM, yyyy', mdy: 'MMMM do, yyyy' })
}

/**
 * A time of day per the user's time-format setting: `8:22pm` for `12h`,
 * `20:22` for `24h`. Every time the app displays goes through this.
 */
export function formatTimeOfDay(date: Date, timeFormat: TimeFormat): string {
  return format(date, timeFormat === '24h' ? 'HH:mm' : 'h:mmaaa')
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
  return formatByDateFormat(date, prefs.dateFormat, SHORT_DATE_PATTERNS)
}

/** How long ago `epochMs` was, in words: `about 2 hours ago`. */
export function formatTimeAgo(epochMs: number): string {
  return formatDistanceToNow(epochMs, { addSuffix: true })
}

/** Human label for a `YYYY-MM` month, e.g. `June 2026`. */
export function monthLabel(month: string): string {
  return format(parseIsoDate(monthStartIso(month)), 'MMMM yyyy')
}

/** Short label for a `YYYY-MM` month, e.g. `Jun` — month-picker grid cells. */
export function monthShortLabel(month: string): string {
  return format(parseIsoDate(monthStartIso(month)), 'MMM')
}

/** The one-letter weekday of an ISO date, e.g. `T`. */
export function weekdayInitial(date: string): string {
  return format(parseIsoDate(date), 'EEEEE')
}

/** Two-letter weekday labels for a calendar's header row, e.g. `Mo`. */
export function weekdayLabels(weekStartDay: WeekStartDay): string[] {
  const weekStart = startOfWeekIso(todayIso(), weekStartDay)
  return Array.from({ length: 7 }, (_, index) => {
    return format(parseIsoDate(addDaysIso(weekStart, index)), 'EEEEEE')
  })
}
