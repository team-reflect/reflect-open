import { differenceInCalendarDays } from 'date-fns'
import { addDaysIso, parseIsoDate } from './dates'

/**
 * The daily surfaces' virtual window (Plan 06b / Plan 19): a **fixed**
 * chronological range of days around an anchor, indexed `0 … count-1` from
 * oldest to newest. Virtual rows/slides are free until mounted, so a generous
 * static window sidesteps bidirectional infinite scroll's prepend/scroll-
 * compensation problem entirely. Index↔date is pure offset math.
 *
 * Two surfaces share this module: the desktop daily stream (a wide, asymmetric
 * window it virtualizes with TanStack Virtual) and the mobile day carousel (a
 * tighter symmetric window Embla pages through). They differ only in radius and
 * in how they treat a date outside the window — see {@link indexOfDate} (clamps
 * to the nearest edge) versus {@link indexWithin} (reports `-1` so the caller
 * can re-anchor around the far date).
 */

/** The desktop stream's default reach: ~5 years back, ~1 year forward. */
export const PAST_DAYS = 5 * 365
export const FUTURE_DAYS = 365

/** How far the window reaches either side of its anchor day. */
export interface DayWindowRadius {
  /** Days before the anchor — index 0 is `anchor - past`. */
  past: number
  /** Days after the anchor — the last index is `anchor + future`. */
  future: number
}

export interface DayWindow {
  /** ISO date of index 0 (the oldest day in the window). */
  start: string
  /** Total number of days (virtual rows/slides). */
  count: number
  /** Index of the anchor day (the date the window was built around). */
  anchorIndex: number
}

/**
 * Build the window around `anchor`, reaching `past` days back and `future` days
 * forward (defaulting to the desktop stream's asymmetric reach). Stable for the
 * life of the view.
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

/** The ISO date at `index` (0 = oldest). */
export function dateAtIndex(window: DayWindow, index: number): string {
  return addDaysIso(window.start, index)
}

/** Signed offset of `date` from the window's first day (may fall out of range). */
function offsetOfDate(window: DayWindow, date: string): number {
  return differenceInCalendarDays(parseIsoDate(date), parseIsoDate(window.start))
}

/**
 * The index of `date` **clamped** to the window's bounds — a date link outside
 * the window still scrolls to the nearest edge instead of erroring. Used by the
 * desktop stream, whose window is wide enough that the clamp is effectively
 * unreachable in normal use.
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
