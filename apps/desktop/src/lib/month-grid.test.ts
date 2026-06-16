import { describe, expect, it } from 'vitest'
import { addMonths, buildMonthGrid, monthLabel, monthOf, weekdayLabels } from './month-grid'

describe('monthOf', () => {
  it('extracts the YYYY-MM month of an ISO date', () => {
    expect(monthOf('2026-06-09')).toBe('2026-06')
    expect(monthOf('1999-12-31')).toBe('1999-12')
  })
})

describe('monthLabel', () => {
  it('formats a human month label', () => {
    expect(monthLabel('2026-06')).toBe('June 2026')
    expect(monthLabel('2026-01')).toBe('January 2026')
  })
})

describe('addMonths', () => {
  it('moves across year boundaries in both directions', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01')
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(addMonths('2026-06', 0)).toBe('2026-06')
  })
})

describe('weekdayLabels', () => {
  it('returns seven labels starting on Monday', () => {
    const labels = weekdayLabels()
    expect(labels).toHaveLength(7)
    expect(labels[0]).toBe('Mo')
    expect(labels[6]).toBe('Su')
  })
})

describe('buildMonthGrid', () => {
  it('pads the month to full Monday-first weeks', () => {
    // June 2026 starts on a Monday and ends on a Tuesday.
    const grid = buildMonthGrid('2026-06')
    expect(grid.start).toBe('2026-06-01')
    expect(grid.end).toBe('2026-07-05')
    expect(grid.weeks).toHaveLength(5)
    for (const week of grid.weeks) {
      expect(week).toHaveLength(7)
    }
  })

  it('flags leading and trailing fill days as outside the month', () => {
    // August 2026 starts on a Saturday.
    const grid = buildMonthGrid('2026-08')
    expect(grid.start).toBe('2026-07-27')
    expect(grid.weeks[0]!.slice(0, 5).every((cell) => !cell.inMonth)).toBe(true)
    expect(grid.weeks[0]![5]).toEqual({ date: '2026-08-01', inMonth: true })
    const lastWeek = grid.weeks[grid.weeks.length - 1]!
    expect(lastWeek[0]).toEqual({ date: '2026-08-31', inMonth: true })
    expect(lastWeek.slice(1).every((cell) => !cell.inMonth)).toBe(true)
  })

  it('covers every day of the month exactly once', () => {
    const grid = buildMonthGrid('2026-02')
    const inMonth = grid.weeks.flat().filter((cell) => cell.inMonth)
    expect(inMonth).toHaveLength(28)
    expect(new Set(inMonth.map((cell) => cell.date)).size).toBe(28)
  })

  it('rejects malformed months', () => {
    expect(() => buildMonthGrid('2026-13')).toThrow(/YYYY-MM/)
    expect(() => buildMonthGrid('June')).toThrow(/YYYY-MM/)
  })

  it('stays contiguous day-by-day across US DST transitions', () => {
    // 2026-03 spans the spring-forward (Mar 8); 2026-11 the fall-back (Nov 1).
    const DAY_MILLIS = 86_400_000
    const utcMillis = (date: string): number => {
      const [year, monthPart, day] = date.split('-').map(Number)
      return Date.UTC(year!, monthPart! - 1, day!)
    }

    for (const { month, lastDay } of [
      { month: '2026-03', lastDay: '2026-03-31' },
      { month: '2026-11', lastDay: '2026-11-30' },
    ]) {
      const grid = buildMonthGrid(month)
      for (const week of grid.weeks) {
        expect(week).toHaveLength(7)
      }

      const cells = grid.weeks.flat()
      for (let index = 1; index < cells.length; index += 1) {
        expect(utcMillis(cells[index]!.date) - utcMillis(cells[index - 1]!.date)).toBe(
          DAY_MILLIS,
        )
      }

      const dates = cells.map((cell) => cell.date)
      expect(dates.filter((date) => date === `${month}-01`)).toHaveLength(1)
      expect(dates.filter((date) => date === lastDay)).toHaveLength(1)
    }
  })
})
