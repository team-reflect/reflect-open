import {
  addDaysToIsoDate,
  formatDate,
  getYearMonth,
  getYearMonthStart,
  getIsoToday,
  isIsoDate,
} from '@reflect/utils'
import { getUserWeekStart, type WeekStartDay } from '@reflect/core'

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

/** The first day of a `YYYY-MM` year-month. Throws when `yearMonth` is malformed. */
function getMonthStart(yearMonth: string): string {
  const start = getYearMonthStart(yearMonth)
  if (!isIsoDate(start)) {
    throw new Error(`expected a YYYY-MM month, got: ${yearMonth}`)
  }
  return start
}

/**
 * Build the full-week grid for a `YYYY-MM` year-month, its weeks starting on `weekStartDay`.
 */
export function buildMonthGrid(yearMonth: string, weekStartDay: WeekStartDay): MonthGrid {
  const weeks: MonthGridCell[][] = []
  const start = getUserWeekStart(getMonthStart(yearMonth), weekStartDay)
  let cursor = start
  while (getYearMonth(cursor) <= yearMonth) {
    const week: MonthGridCell[] = []
    for (let day = 0; day < 7; day += 1) {
      week.push({ date: cursor, inMonth: getYearMonth(cursor) === yearMonth })
      cursor = addDaysToIsoDate(cursor, 1)
    }
    weeks.push(week)
  }
  return { month: yearMonth, weeks, start, end: addDaysToIsoDate(cursor, -1) }
}

/** Human label for a `YYYY-MM` year-month, e.g. `June 2026`. */
export function formatMonthLabel(yearMonth: string): string {
  return formatDate(getMonthStart(yearMonth), 'MMMM yyyy')
}

/** Short label for a `YYYY-MM` year-month, e.g. `Jun` — month-picker grid cells. */
export function formatShortMonthLabel(yearMonth: string): string {
  return formatDate(getMonthStart(yearMonth), 'MMM')
}

/** Two-letter weekday labels for the grid's header row, e.g. `Mo`. */
export function getWeekdayLabels(weekStartDay: WeekStartDay): string[] {
  const weekStart = getUserWeekStart(getIsoToday(), weekStartDay)
  return Array.from({ length: 7 }, (_, index) => {
    return formatDate(addDaysToIsoDate(weekStart, index), 'EEEEEE')
  })
}
