/**
 * Calendar arithmetic on ISO `YYYY-MM-DD` date strings, computed in UTC.
 *
 * UTC sidesteps daylight saving entirely: adding days or months can never skip
 * or repeat a day, so callers get correct calendar shifts without a
 * timezone-aware date library. "Today" is intentionally absent — it depends on
 * the local clock and belongs to `@reflect/core`'s `ClockService`.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * UTC midnight on the given day. `setUTCFullYear` rather than `Date.UTC`: the
 * latter remaps years 0-99 to 1900-1999.
 */
function utcDate(year: number, monthIndex: number, day: number): Date {
  const date = new Date(0)
  date.setUTCFullYear(year, monthIndex, day)
  return date
}

/** Parse an ISO `YYYY-MM-DD` string as a UTC-midnight {@link Date}. */
export function parseIsoUtc(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number]
  return utcDate(year, month - 1, day)
}

/** Format a {@link Date} as an ISO `YYYY-MM-DD` string from its UTC fields. */
export function formatIsoUtc(date: Date): string {
  return isoFromParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

/** Build an ISO `YYYY-MM-DD` string from numeric parts (1-based `month`). */
export function isoFromParts(year: number, month: number, day: number): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, '0')
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
}

/** The ISO date `days` after `iso` (negative for before). DST-safe. */
export function addDaysIso(iso: string, days: number): string {
  const date = parseIsoUtc(iso)
  date.setUTCDate(date.getUTCDate() + days)
  return formatIsoUtc(date)
}

/**
 * The ISO date `months` after `iso` (negative for before), clamping to the end
 * of the target month — so `2024-01-31` plus one month is `2024-02-29`, matching
 * date-fns `addMonths`.
 */
export function addMonthsIso(iso: string, months: number): string {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number]
  const zeroBased = month - 1 + months
  const targetYear = year + Math.floor(zeroBased / 12)
  const targetMonth = ((zeroBased % 12) + 12) % 12
  const lastDay = utcDate(targetYear, targetMonth + 1, 0).getUTCDate()
  return isoFromParts(targetYear, targetMonth + 1, Math.min(day, lastDay))
}

/** Day of week for an ISO date: 0 = Sunday … 6 = Saturday. */
export function weekdayIso(iso: string): number {
  return parseIsoUtc(iso).getUTCDay()
}

/**
 * Is `value` a real calendar day, not merely `YYYY-MM-DD`-shaped? Rejects
 * impossible dates such as `2026-02-31`. Assumes the input is already
 * ISO-shaped; use {@link isIsoDate} for untrusted strings.
 */
export function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  if (month < 1 || month > 12) {
    return false
  }
  // Day 0 of the next month = the last day of `month` (leap years included).
  const daysInMonth = utcDate(year, month, 0).getUTCDate()
  return day >= 1 && day <= daysInMonth
}

/** Is `value` a syntactically ISO `YYYY-MM-DD` string naming a real calendar day? */
export function isIsoDate(value: string): boolean {
  return ISO_DATE_RE.test(value) && isCalendarDate(value)
}
