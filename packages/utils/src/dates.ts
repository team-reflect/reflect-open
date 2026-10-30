import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  format,
  formatDistanceToNow,
  getDay,
  isExists,
  isValid,
  parse,
  parseISO,
  startOfWeek,
  type Day,
} from 'date-fns'

/**
 * Calendar math on local ISO `YYYY-MM-DD` dates and `YYYY-MM` months. Daily
 * notes are keyed by the user's local calendar day, so every date here is a
 * local-midnight {@link Date} under the hood. This module is the only place in
 * the workspace that calls date-fns.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Is `value` an ISO `YYYY-MM-DD` string naming a real calendar day? */
export function isIsoDate(value: string): boolean {
  return ISO_DATE_RE.test(value) && isValid(parseISO(value))
}

/** Local midnight of an ISO `YYYY-MM-DD` date. */
export function parseIsoDate(iso: string): Date {
  return parseISO(iso)
}

/** The local calendar day of `date` as ISO `YYYY-MM-DD`. */
export function formatIsoDate(date: Date): string {
  return format(date, 'yyyy-MM-dd')
}

/** Today's local calendar day as ISO `YYYY-MM-DD`. */
export function todayIso(): string {
  return formatIsoDate(new Date())
}

/** The ISO date of `year`, `month` (1-based), and `day`, or `null` when no such day exists. */
export function isoDateFromParts(year: number, month: number, day: number): string | null {
  return isExists(year, month - 1, day) ? formatIsoDate(new Date(year, month - 1, day)) : null
}

/** The ISO date `days` after `iso` (negative for before). */
export function addDaysIso(iso: string, days: number): string {
  return formatIsoDate(addDays(parseIsoDate(iso), days))
}

/**
 * The ISO date `months` after `iso` (negative for before), clamping to the end
 * of the target month: `2024-01-31` plus one month is `2024-02-29`.
 */
export function addMonthsIso(iso: string, months: number): string {
  return formatIsoDate(addMonths(parseIsoDate(iso), months))
}

/** The number of calendar days from `earlier` to `later` (negative when `later` is earlier). */
export function differenceInDaysIso(later: string, earlier: string): number {
  return differenceInCalendarDays(parseIsoDate(later), parseIsoDate(earlier))
}

/** Day of week of an ISO date: 0 = Sunday … 6 = Saturday. */
export function weekdayIso(iso: string): number {
  return getDay(parseIsoDate(iso))
}

/** A day of the week: 0 = Sunday … 6 = Saturday. */
export type Weekday = Day

/** The first day of `iso`'s week, for a week that starts on `weekStartsOn`. */
export function startOfWeekIso(iso: string, weekStartsOn: Weekday): string {
  return formatIsoDate(startOfWeek(parseIsoDate(iso), { weekStartsOn }))
}

/** Epoch ms of the local start of the ISO day `days` after `iso`. */
export function isoDayStartMs(iso: string, days: number): number {
  return addDays(parseIsoDate(iso), days).getTime()
}

/** The calendar year of an ISO date or a `YYYY-MM` month. */
export function yearOf(isoOrMonth: string): number {
  return Number(isoOrMonth.slice(0, 4))
}

/** The `YYYY-MM` month of an ISO date. */
export function monthOf(iso: string): string {
  return iso.slice(0, 7)
}

/** The ISO date of the first day of a `YYYY-MM` month. */
export function monthStartIso(month: string): string {
  return `${month}-01`
}

/** The `YYYY-MM` month `months` after `month` (negative for before). */
export function addMonthsToMonth(month: string, months: number): string {
  return monthOf(addMonthsIso(monthStartIso(month), months))
}

/** The twelve `YYYY-MM` months of `year`, January first. */
export function monthsOfYear(year: number): string[] {
  return Array.from({ length: 12 }, (_, index) => format(new Date(year, index, 1), 'yyyy-MM'))
}

/** Format `date` with a date-fns pattern, such as `MMMM yyyy`. */
export function formatDate(date: Date, pattern: string): string {
  return format(date, pattern)
}

/** Parse `value` with a date-fns pattern, or `null` when it names no real moment. */
export function parseDate(value: string, pattern: string): Date | null {
  const date = parse(value, pattern, new Date())
  return isValid(date) ? date : null
}

/** How long ago `epochMs` was, in words: `about 2 hours ago`. */
export function formatTimeAgo(epochMs: number): string {
  return formatDistanceToNow(epochMs, { addSuffix: true })
}
