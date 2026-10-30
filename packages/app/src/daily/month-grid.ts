import {
  addDaysIso,
  formatDate,
  monthOf,
  monthStartIso,
  parseIsoDate,
  todayIso,
} from '@reflect/utils'
import { weekStartOf, type WeekStartDay } from '@reflect/core'

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
  const start = weekStartOf(monthStartIso(month), weekStartDay)
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

/** Human label for a `YYYY-MM` month, e.g. `June 2026`. */
export function monthLabel(month: string): string {
  return formatDate(parseIsoDate(monthStartIso(month)), 'MMMM yyyy')
}

/** Short label for a `YYYY-MM` month, e.g. `Jun` — month-picker grid cells. */
export function monthShortLabel(month: string): string {
  return formatDate(parseIsoDate(monthStartIso(month)), 'MMM')
}

/** Two-letter weekday labels for the grid's header row, e.g. `Mo`. */
export function weekdayLabels(weekStartDay: WeekStartDay): string[] {
  const weekStart = weekStartOf(todayIso(), weekStartDay)
  return Array.from({ length: 7 }, (_, index) => { return formatDate(parseIsoDate(addDaysIso(weekStart, index)), 'EEEEEE') },
  )
}
