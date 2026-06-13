import { format, getDay } from 'date-fns'
import type { WeekStartDay } from '@reflect/core'
import { addDaysIso, parseIsoDate } from '@/lib/dates'

/**
 * Date math for the V1-parity Daily surface's **calendar strip** — the month
 * header and week row above the day carousel. Pure; the strip component stays
 * thin over it. The carousel's own slide-window math is the shared
 * {@link module:@/lib/day-window} (the desktop daily stream uses the same
 * module), so day-paging stays consistent across surfaces.
 */

/** The seven ISO dates of `date`'s week, honoring the week-start setting. */
export function weekOf(date: string, weekStart: WeekStartDay): string[] {
  const weekday = getDay(parseIsoDate(date)) // 0 = Sunday … 6 = Saturday
  const offsetToFirst = weekStart === 'monday' ? (weekday === 0 ? -6 : 1 - weekday) : -weekday
  const first = addDaysIso(date, offsetToFirst)
  return Array.from({ length: 7 }, (_, index) => addDaysIso(first, index))
}

/** The strip's month header, e.g. `June 2026`. */
export function monthLabel(date: string): string {
  return format(parseIsoDate(date), 'MMMM yyyy')
}
