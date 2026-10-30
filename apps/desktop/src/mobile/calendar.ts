/*
 * The calendar strip's week math lives in `@reflect/app`
 * (`daily/week-window.ts`). This module re-exports it.
 */
export {
  createWeekWindow,
  monthPickTarget,
  WEEK_WINDOW_RADIUS,
  weekAtIndex,
  weekIndexOf,
  weekOf,
  type WeekWindow,
} from '@reflect/app'
