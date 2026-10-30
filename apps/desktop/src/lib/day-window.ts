/*
 * The daily surfaces' day window lives in `@reflect/app` (`daily/day-window.ts`).
 * This module re-exports it.
 */
export {
  createDayWindow,
  dateAtIndex,
  extendDayWindowBack,
  FUTURE_DAYS,
  indexOfDate,
  indexWithin,
  neighborDate,
  PAST_DAYS,
  type DayWindow,
  type DayWindowRadius,
} from '@reflect/app'
