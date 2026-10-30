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
 * Calendar math on local ISO `YYYY-MM-DD` dates and `YYYY-MM` year-months. Daily
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
export function parseIsoDate(date: string): Date {
  return parseISO(date)
}

/** The local calendar day of `date` as ISO `YYYY-MM-DD`. */
export function formatIsoDate(date: Date): string {
  return format(date, 'yyyy-MM-dd')
}

/** Today's local calendar day as ISO `YYYY-MM-DD`. */
export function getIsoToday(): string {
  return formatIsoDate(new Date())
}

/** The ISO date of `year`, `month` (1-based), and `day`, or `null` when no such day exists. */
export function getIsoDateFromParts(year: number, month: number, day: number): string | null {
  return isExists(year, month - 1, day) ? formatIsoDate(new Date(year, month - 1, day)) : null
}

/** The ISO date `days` after `date` (negative for before). */
export function addDaysToIsoDate(date: string, days: number): string {
  return formatIsoDate(addDays(parseIsoDate(date), days))
}

/**
 * The ISO date `months` after `date` (negative for before), clamping to the end
 * of the target month: `2024-01-31` plus one month is `2024-02-29`.
 */
export function addMonthsToIsoDate(date: string, months: number): string {
  return formatIsoDate(addMonths(parseIsoDate(date), months))
}

/** The number of calendar days from `earlier` to `later` (negative when `later` is earlier). */
export function getDaysBetweenIsoDates(later: string, earlier: string): number {
  return differenceInCalendarDays(parseIsoDate(later), parseIsoDate(earlier))
}

/** Day of week of an ISO date: 0 = Sunday … 6 = Saturday. */
export function getWeekday(date: string): Weekday {
  return getDay(parseIsoDate(date)) as Weekday
}

/** A day of the week: 0 = Sunday … 6 = Saturday. */
export type Weekday = Day

/** The first day of `date`'s week, for a week that starts on `weekStartsOn`. */
export function getWeekStart(date: string, weekStartsOn: Weekday): string {
  return formatIsoDate(startOfWeek(parseIsoDate(date), { weekStartsOn }))
}

/** The calendar year of an ISO date or a `YYYY-MM` year-month. */
export function getYear(dateOrYearMonth: string): number {
  return Number(dateOrYearMonth.slice(0, 4))
}

/** The `YYYY-MM` year-month of an ISO date. */
export function getYearMonth(date: string): string {
  return date.slice(0, 7)
}

/** The ISO date of the first day of a `YYYY-MM` year-month. */
export function getYearMonthStart(yearMonth: string): string {
  return `${yearMonth}-01`
}

/** The `YYYY-MM` year-month `months` after `yearMonth` (negative for before). */
export function addMonthsToYearMonth(yearMonth: string, months: number): string {
  return getYearMonth(addMonthsToIsoDate(getYearMonthStart(yearMonth), months))
}

/** The twelve `YYYY-MM` year-months of `year`, January first. */
export function getYearMonthsOfYear(year: number): string[] {
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
