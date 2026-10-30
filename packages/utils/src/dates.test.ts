import { describe, expect, it } from 'vitest'
import {
  addDaysIso,
  addMonthsIso,
  addMonthsToMonth,
  isIsoDate,
  isoDateFromParts,
  monthOf,
  monthsOfYear,
  startOfWeekIso,
  todayIso,
  weekdayIso,
} from './dates.ts'

describe('addDaysIso', () => {
  it('adds and subtracts calendar days across month and year boundaries', () => {
    expect(addDaysIso('2020-01-01', -1)).toBe('2019-12-31')
    expect(addDaysIso('2020-02-28', 1)).toBe('2020-02-29') // leap year
    expect(addDaysIso('2021-02-28', 1)).toBe('2021-03-01')
    expect(addDaysIso('2020-01-01', 0)).toBe('2020-01-01')
  })

  it('is DST-safe (a spring-forward day still advances by one calendar day)', () => {
    // 2020-03-08 is the US spring-forward day.
    expect(addDaysIso('2020-03-08', 1)).toBe('2020-03-09')
  })
})

describe('addMonthsIso', () => {
  it('clamps to the end of the target month (date-fns semantics)', () => {
    expect(addMonthsIso('2024-01-31', 1)).toBe('2024-02-29') // leap year
    expect(addMonthsIso('2023-01-31', 1)).toBe('2023-02-28')
    expect(addMonthsIso('2024-03-31', -1)).toBe('2024-02-29')
  })

  it('rolls over years in both directions', () => {
    expect(addMonthsIso('2020-06-15', 12)).toBe('2021-06-15')
    expect(addMonthsIso('2020-01-15', -1)).toBe('2019-12-15')
  })
})

describe('weekdayIso', () => {
  it('returns 0 for Sunday through 6 for Saturday', () => {
    expect(weekdayIso('2020-01-01')).toBe(3) // Wednesday
    expect(weekdayIso('2020-01-05')).toBe(0) // Sunday
    expect(weekdayIso('2020-01-04')).toBe(6) // Saturday
  })
})

describe('isoDateFromParts', () => {
  it('builds a zero-padded ISO date, or null for a day that does not exist', () => {
    expect(isoDateFromParts(2020, 1, 2)).toBe('2020-01-02')
    expect(isoDateFromParts(2024, 2, 29)).toBe('2024-02-29')
    expect(isoDateFromParts(2023, 2, 29)).toBeNull()
    expect(isoDateFromParts(2026, 13, 1)).toBeNull()
  })
})

describe('isIsoDate / todayIso', () => {
  it('accepts real YYYY-MM-DD days and rejects everything else', () => {
    expect(isIsoDate('2020-01-01')).toBe(true)
    expect(isIsoDate('2024-02-29')).toBe(true)
    expect(isIsoDate('2023-02-29')).toBe(false)
    expect(isIsoDate('2026-02-31')).toBe(false)
    expect(isIsoDate('2026-13-01')).toBe(false)
    expect(isIsoDate('2020-1-1')).toBe(false)
    expect(isIsoDate('20200101')).toBe(false)
    expect(isIsoDate('2020-01-01T10:00')).toBe(false)
    expect(isIsoDate('not-a-date')).toBe(false)
  })

  it('todayIso returns a valid local ISO date', () => {
    expect(isIsoDate(todayIso())).toBe(true)
  })
})

/**
 * 2026-06-12 is a Friday; 2026-06-14 a Sunday.
 */
describe('startOfWeekIso', () => {
  it('finds the first day of the week for each week start', () => {
    expect(startOfWeekIso('2026-06-12', 1)).toBe('2026-06-08')
    expect(startOfWeekIso('2026-06-12', 0)).toBe('2026-06-07')
    expect(startOfWeekIso('2026-06-12', 6)).toBe('2026-06-06')
  })

  it('keeps a Sunday in its own Monday-first week', () => {
    expect(startOfWeekIso('2026-06-14', 1)).toBe('2026-06-08')
  })

  it('is a fixed point on the week-start day itself', () => {
    expect(startOfWeekIso('2026-06-08', 1)).toBe('2026-06-08')
    expect(startOfWeekIso('2026-06-07', 0)).toBe('2026-06-07')
    expect(startOfWeekIso('2026-06-13', 6)).toBe('2026-06-13')
  })
})

describe('months', () => {
  it('monthOf extracts the YYYY-MM month of an ISO date', () => {
    expect(monthOf('2026-06-09')).toBe('2026-06')
  })

  it('addMonthsToMonth moves across year boundaries in both directions', () => {
    expect(addMonthsToMonth('2026-12', 1)).toBe('2027-01')
    expect(addMonthsToMonth('2026-01', -1)).toBe('2025-12')
    expect(addMonthsToMonth('2026-06', 0)).toBe('2026-06')
  })

  it('monthsOfYear lists the twelve months', () => {
    expect(monthsOfYear(2026)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
      '2026-12',
    ])
  })
})
