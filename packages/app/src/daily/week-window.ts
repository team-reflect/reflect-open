import {
  addDaysToIsoDate,
  getDaysBetweenIsoDates,
  getYearMonth,
  getYearMonthStart,
} from '@reflect/utils'
import { getUserWeekStart, type WeekStartDay } from '@reflect/core'

/**
 * Date math for the V1-parity Daily surface's **calendar strip** — the month
 * header and pageable week row above the day carousel. Pure; the strip
 * component and its `useWeekStrip` hook stay thin over it. The carousel's own
 * slide-window math is the shared `day-window.ts` (the desktop daily stream
 * uses the same module), so day-paging stays consistent across surfaces.
 */

/**
 * The seven ISO dates of `date`'s week, honoring the week-start setting.
 */
export function weekOf(date: string, weekStart: WeekStartDay): string[] {
  const first = getUserWeekStart(date, weekStart)
  return Array.from({ length: 7 }, (_, index) => addDaysToIsoDate(first, index))
}

/**
 * Where the month picker lands when a `YYYY-MM` month is picked: the
 * selection's own month keeps the selection, today's month goes to today,
 * and any other month opens on its first day.
 */
export function monthPickTarget(month: string, selected: string, today: string): string {
  if (getYearMonth(selected) === month) {
    return selected
  }
  if (getYearMonth(today) === month) {
    return today
  }
  return getYearMonthStart(month)
}

/**
 * The week strip's slide window: a fixed run of consecutive weeks (each one
 * strip slide), identified by their week-start dates. The strip re-centers it
 * when paging nears an edge — the same virtual-window pattern as the day
 * carousel's `day-window.ts`, in units of weeks.
 */
export interface WeekWindow {
  /**
   * Week-start ISO date of index 0 (the oldest week in the window).
   */
  start: string
  /**
   * Total number of weeks (strip slides).
   */
  count: number
  /**
   * Index of the anchor week (the window was centered on it).
   */
  anchorIndex: number
}

/**
 * Weeks either side of the strip's anchor (~half a year each way).
 */
export const WEEK_WINDOW_RADIUS = 26

/**
 * Build the window centered on the week containing `date`.
 */
export function createWeekWindow(
  date: string,
  weekStart: WeekStartDay,
  radius: number = WEEK_WINDOW_RADIUS,
): WeekWindow {
  return {
    start: addDaysToIsoDate(getUserWeekStart(date, weekStart), -radius * 7),
    count: radius * 2 + 1,
    anchorIndex: radius,
  }
}

/**
 * The week-start ISO date at `index` (0 = oldest).
 */
export function weekAtIndex(window: WeekWindow, index: number): string {
  return addDaysToIsoDate(window.start, index * 7)
}

/**
 * The index of the week containing `date`, or `-1` when it lies outside the
 * window — including when the window was built for a **different week-start
 * day** (its weeks no longer align), the strip's signal to rebuild it.
 */
export function weekIndexOf(window: WeekWindow, date: string, weekStart: WeekStartDay): number {
  const target = getUserWeekStart(date, weekStart)
  const offset = getDaysBetweenIsoDates(target, window.start)
  if (offset % 7 !== 0) {
    return -1
  }
  const index = offset / 7
  return index >= 0 && index < window.count ? index : -1
}
