import {
  addDays,
  addMonths as addMonthsToDate,
  endOfMonth,
  endOfWeek,
  format,
  isValid,
  parse,
  startOfMonth,
  startOfWeek,
} from 'date-fns'
import { addDaysIso } from './dates'

/**
 * Pure month-grid math for the daily sidebar's calendar (no DOM, no queries).
 * Months are `YYYY-MM` strings and days are ISO `YYYY-MM-DD` strings — the
 * same local-calendar contract as `lib/dates`. Weeks start on Monday (ISO
 * 8601), matching the chronological-spine framing of the daily stream.
 */

const MONTH_FORMAT = 'yyyy-MM'
const ISO_DATE_FORMAT = 'yyyy-MM-dd'
const WEEK_STARTS_ON = 1

/** One cell of the calendar grid. */
export interface MonthGridCell {
  /** ISO date of the cell. */
  date: string
  /** Whether the cell belongs to the grid's month (vs. leading/trailing fill). */
  inMonth: boolean
}

/** A month rendered as full weeks, padded with adjacent-month days. */
export interface MonthGrid {
  /** The grid's month as `YYYY-MM`. */
  month: string
  /** Rows of seven cells, oldest week first. */
  weeks: MonthGridCell[][]
  /** ISO date of the first cell (for range queries over the visible grid). */
  start: string
  /** ISO date of the last cell (inclusive). */
  end: string
}

function parseMonth(month: string): Date {
  const parsed = parse(month, MONTH_FORMAT, new Date())
  if (!isValid(parsed)) {
    throw new Error(`expected a YYYY-MM month, got: ${month}`)
  }
  return parsed
}

/** The `YYYY-MM` month containing the ISO `date`. */
export function monthOf(date: string): string {
  return date.slice(0, 7)
}

/** Human label for a `YYYY-MM` month, e.g. `June 2026`. */
export function monthLabel(month: string): string {
  return format(parseMonth(month), 'MMMM yyyy')
}

/** The `YYYY-MM` month `delta` months after `month` (negative for before). */
export function addMonths(month: string, delta: number): string {
  return format(addMonthsToDate(parseMonth(month), delta), MONTH_FORMAT)
}

/** Two-letter weekday labels for the grid's header row, Monday first. */
export function weekdayLabels(): string[] {
  const weekStart = startOfWeek(new Date(), { weekStartsOn: WEEK_STARTS_ON })
  return [...Array(7).keys()].map((dayOffset) =>
    format(addDays(weekStart, dayOffset), 'EEEEEE'),
  )
}

/** Build the full-week grid for a `YYYY-MM` month. */
export function buildMonthGrid(month: string): MonthGrid {
  const monthStart = startOfMonth(parseMonth(month))
  const gridStart = format(
    startOfWeek(monthStart, { weekStartsOn: WEEK_STARTS_ON }),
    ISO_DATE_FORMAT,
  )
  const gridEnd = format(
    endOfWeek(endOfMonth(monthStart), { weekStartsOn: WEEK_STARTS_ON }),
    ISO_DATE_FORMAT,
  )

  const weeks: MonthGridCell[][] = []
  let cursor = gridStart
  while (cursor <= gridEnd) {
    const week: MonthGridCell[] = []
    for (let day = 0; day < 7; day += 1) {
      week.push({ date: cursor, inMonth: monthOf(cursor) === month })
      cursor = addDaysIso(cursor, 1)
    }
    weeks.push(week)
  }
  return { month, weeks, start: gridStart, end: gridEnd }
}
