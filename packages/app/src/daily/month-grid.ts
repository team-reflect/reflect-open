import {
  addDaysIso,
  monthOf,
  monthStartIso,
  startOfWeekIso,
  type WeekStartDay,
} from '@reflect/utils'

/**
 * Pure month-grid math for the daily sidebar's calendar (no DOM, no queries).
 * Months are `YYYY-MM` strings and days are ISO `YYYY-MM-DD` strings.
 */

/**
 * One cell of the calendar grid.
 */
export interface MonthGridCell {
  /**
   * ISO date of the cell.
   */
  date: string
  /**
   * Whether the cell belongs to the grid's month (vs. leading/trailing fill).
   */
  inMonth: boolean
}

/**
 * A month rendered as full weeks, padded with adjacent-month days.
 */
export interface MonthGrid {
  /**
   * The grid's month as `YYYY-MM`.
   */
  month: string
  /**
   * Rows of seven cells, oldest week first.
   */
  weeks: MonthGridCell[][]
  /**
   * ISO date of the first cell (for range queries over the visible grid).
   */
  start: string
  /**
   * ISO date of the last cell (inclusive).
   */
  end: string
}

/**
 * Build the full-week grid for a `YYYY-MM` month, its weeks starting on `weekStartDay`.
 */
export function buildMonthGrid(month: string, weekStartDay: WeekStartDay): MonthGrid {
  const weeks: MonthGridCell[][] = []
  const start = startOfWeekIso(monthStartIso(month), weekStartDay)
  let cursor = start
  while (monthOf(cursor) <= month) {
    const week: MonthGridCell[] = []
    for (let day = 0; day < 7; day += 1) {
      week.push({ date: cursor, inMonth: monthOf(cursor) === month })
      cursor = addDaysIso(cursor, 1)
    }
    weeks.push(week)
  }
  return { month, weeks, start, end: addDaysIso(cursor, -1) }
}
