import { differenceInCalendarDays } from 'date-fns'
import { addDaysIso } from '@reflect/utils'
import { parseIsoDate } from '@reflect/core'

/**
 * The daily surfaces' virtual window (Plan 06b / Plan 19): a chronological
 * range of days around an anchor, indexed `0 … count-1` from oldest to newest.
 * Virtual rows/slides are free until mounted, so a generous window that changes
 * only on navigation sidesteps bidirectional infinite scroll's prepend/scroll-
 * compensation problem while the user scrolls. Index↔date is pure offset math.
 *
 * Two surfaces share this module: the desktop daily stream (a wide, asymmetric
 * window it virtualizes with virtua) and the mobile day carousel (a tighter
 * symmetric window Embla pages through). They differ in radius and in how they
 * treat a date outside the window: the stream grows back to an earlier date
 * ({@link extendDayWindowBack}) and clamps a later one to its end
 * ({@link indexOfDate}), while the carousel re-anchors around it
 * ({@link indexWithin} reports `-1`).
 */

/**
 * The desktop stream's default reach: ~5 years back, ~1 year forward.
 */
export const PAST_DAYS = 5 * 365
export const FUTURE_DAYS = 365

/**
 * How far the window reaches either side of its anchor day.
 */
export interface DayWindowRadius {
  /**
   * Days before the anchor — index 0 is `anchor - past`.
   */
  past: number
  /**
   * Days after the anchor — the last index is `anchor + future`.
   */
  future: number
}

export interface DayWindow {
  /**
   * ISO date of index 0 (the oldest day in the window).
   */
  start: string
  /**
   * Total number of days (virtual rows/slides).
   */
  count: number
  /**
   * Index of the anchor day (the date the window was built around).
   */
  anchorIndex: number
}

/**
 * Build the window around `anchor`, reaching `past` days back and `future` days
 * forward (defaulting to the desktop stream's asymmetric reach).
 */
export function createDayWindow(
  anchor: string,
  { past = PAST_DAYS, future = FUTURE_DAYS }: Partial<DayWindowRadius> = {},
): DayWindow {
  return {
    start: addDaysIso(anchor, -past),
    count: past + future + 1,
    anchorIndex: past,
  }
}

/**
 * `window` grown back to start {@link PAST_DAYS} before `date`, so a far-past
 * arrival keeps the stream's usual reach behind it; `window` itself when `date`
 * is not before its start. Days are only ever added before the start: the
 * anchor keeps its date and its index moves by the number of days added.
 */
export function extendDayWindowBack(window: DayWindow, date: string): DayWindow {
  if (offsetOfDate(window, date) >= 0) {
    return window
  }
  const start = addDaysIso(date, -PAST_DAYS)
  const added = -offsetOfDate(window, start)
  return { start, count: window.count + added, anchorIndex: window.anchorIndex + added }
}

/**
 * The ISO date at `index` (0 = oldest).
 */
export function dateAtIndex(window: DayWindow, index: number): string {
  return addDaysIso(window.start, index)
}

/**
 * Signed offset of `date` from the window's first day (may fall out of range).
 */
function offsetOfDate(window: DayWindow, date: string): number {
  return differenceInCalendarDays(parseIsoDate(date), parseIsoDate(window.start))
}

/**
 * The index of `date` **clamped** to the window's bounds — a date link outside
 * the window still scrolls to the nearest edge instead of erroring. Used by the
 * desktop stream, which first extends its window back to include an earlier
 * day, so only a day past its far end clamps.
 */
export function indexOfDate(window: DayWindow, date: string): number {
  return Math.max(0, Math.min(window.count - 1, offsetOfDate(window, date)))
}

/**
 * The index of `date` within the window, or `-1` when it lies outside. The
 * mobile carousel uses the `-1` as its signal to re-anchor the window around a
 * far date link rather than scroll to an edge.
 */
export function indexWithin(window: DayWindow, date: string): number {
  const index = offsetOfDate(window, date)
  return index >= 0 && index < window.count ? index : -1
}

/**
 * The in-window day `delta` steps from `date` (`-1` = previous, `+1` = next), or
 * `null` at the window's edge or when `date` lies outside it.
 */
export function neighborDate(window: DayWindow, date: string, delta: 1 | -1): string | null {
  const index = indexWithin(window, date)
  if (index < 0) {
    return null
  }
  const target = index + delta
  return target >= 0 && target < window.count ? dateAtIndex(window, target) : null
}
