import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  format,
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
 * local-midnight {@link Date} under the hood. This module and `date-labels.ts`
 * are the only places in the workspace that call date-fns.
 */

/** Regex source of an ISO `YYYY-MM-DD` date, for building larger patterns. */
export const ISO_DATE_PATTERN = String.raw`\d{4}-\d{2}-\d{2}`

const ISO_DATE_RE = new RegExp(`^${ISO_DATE_PATTERN}$`)

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

/** The week-start setting's choices. */
export const WEEK_START_DAYS = ['monday', 'sunday', 'saturday'] as const

export type WeekStartDay = (typeof WEEK_START_DAYS)[number]

const WEEK_STARTS_ON: Record<WeekStartDay, Day> = { sunday: 0, monday: 1, saturday: 6 }

/** The first day of `iso`'s week, for a week that starts on `weekStartDay`. */
export function startOfWeekIso(iso: string, weekStartDay: WeekStartDay): string {
  return formatIsoDate(
    startOfWeek(parseIsoDate(iso), { weekStartsOn: WEEK_STARTS_ON[weekStartDay] }),
  )
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

const FILE_STAMP_FORMAT = 'yyyy-MM-dd-HHmmss-SSS'

/** Regex source of a {@link formatFileStamp} stamp, for building larger patterns. */
export const FILE_STAMP_PATTERN = String.raw`${ISO_DATE_PATTERN}-\d{6}-\d{3}`

/** A local timestamp for file names: `2026-06-12-153022-845`. */
export function formatFileStamp(date: Date): string {
  return format(date, FILE_STAMP_FORMAT)
}

/**
 * The local ISO date and `HH:mm:ss` time of a {@link formatFileStamp} stamp, or
 * `null` when the stamp names no real moment.
 */
export function parseFileStamp(stamp: string): { date: string; time: string } | null {
  const date = parse(stamp, FILE_STAMP_FORMAT, new Date())
  return isValid(date) ? { date: formatIsoDate(date), time: format(date, 'HH:mm:ss') } : null
}
