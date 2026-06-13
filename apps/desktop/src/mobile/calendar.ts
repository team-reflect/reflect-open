import { differenceInCalendarDays, format, getDay } from 'date-fns'
import type { WeekStartDay } from '@reflect/core'
import { addDaysIso, parseIsoDate } from '@/lib/dates'

/**
 * Date math for the V1-parity Daily surface: the week calendar strip and the
 * swipeable day carousel. Pure; the components stay thin over it.
 */

/**
 * Days either side of the carousel anchor. A generous fixed window (≈1 year
 * each way) sidesteps runtime re-anchoring — Embla measures the empty slides
 * cheaply, and only slides near the selection mount an editor (the same
 * "generous static window" tactic the desktop daily stream uses with
 * TanStack Virtual). Anchored once at mount; a date-link far outside it is a
 * route navigation, not a swipe.
 */
export const CAROUSEL_RADIUS = 366

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

/** A fixed slide window around an anchor date. */
export interface CarouselWindow {
  /** ISO date of slide 0 (the oldest). */
  start: string
  /** Total slide count. */
  count: number
}

/** Build the window centered on `anchor` (the selected day at mount). */
export function carouselWindow(anchor: string): CarouselWindow {
  return { start: addDaysIso(anchor, -CAROUSEL_RADIUS), count: CAROUSEL_RADIUS * 2 + 1 }
}

/** The ISO date at `index` (0 = oldest). */
export function carouselDateAt(window: CarouselWindow, index: number): string {
  return addDaysIso(window.start, index)
}

/** The slide index of `date`, or `-1` when it lies outside the window. */
export function carouselIndexOf(window: CarouselWindow, date: string): number {
  const index = differenceInCalendarDays(parseIsoDate(date), parseIsoDate(window.start))
  return index >= 0 && index < window.count ? index : -1
}
