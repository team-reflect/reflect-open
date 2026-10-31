import { describe, expect, it } from 'vitest'
import {
  addDaysToIsoDate,
  addMonthsToIsoDate,
  addMonthsToYearMonth,
  isIsoDate,
  getIsoDateFromParts,
  getYearMonth,
  getYearMonthsOfYear,
  getWeekStart,
  getIsoToday,
  getWeekday,
} from './dates.ts'

describe('addDaysToIsoDate', () => {
  it('adds and subtracts calendar days across month and year boundaries', () => {
    expect(addDaysToIsoDate('2020-01-01', -1)).toBe('2019-12-31')
    expect(addDaysToIsoDate('2020-02-28', 1)).toBe('2020-02-29') // leap year
    expect(addDaysToIsoDate('2021-02-28', 1)).toBe('2021-03-01')
    expect(addDaysToIsoDate('2020-01-01', 0)).toBe('2020-01-01')
  })

  it('does not skip a day that a time zone skipped', () => {
    // `Pacific/Apia` had no 2011-12-30.
    expect(addDaysToIsoDate('2011-12-29', 1)).toBe('2011-12-30')
    expect(addDaysToIsoDate('2011-12-31', -1)).toBe('2011-12-30')
  })

  it('is DST-safe (a spring-forward day still advances by one calendar day)', () => {
    // 2020-03-08 is the US spring-forward day.
    expect(addDaysToIsoDate('2020-03-08', 1)).toBe('2020-03-09')
  })
})

describe('addMonthsToIsoDate', () => {
  it('clamps to the end of the target month (date-fns semantics)', () => {
    expect(addMonthsToIsoDate('2024-01-31', 1)).toBe('2024-02-29') // leap year
    expect(addMonthsToIsoDate('2023-01-31', 1)).toBe('2023-02-28')
    expect(addMonthsToIsoDate('2024-03-31', -1)).toBe('2024-02-29')
  })

  it('rolls over years in both directions', () => {
    expect(addMonthsToIsoDate('2020-06-15', 12)).toBe('2021-06-15')
    expect(addMonthsToIsoDate('2020-01-15', -1)).toBe('2019-12-15')
  })
})

describe('getWeekday', () => {
  it('returns 0 for Sunday through 6 for Saturday', () => {
    expect(getWeekday('2020-01-01')).toBe(3) // Wednesday
    expect(getWeekday('2020-01-05')).toBe(0) // Sunday
    expect(getWeekday('2020-01-04')).toBe(6) // Saturday
  })
})

describe('getIsoDateFromParts', () => {
  it('builds a zero-padded ISO date, or null for a day that does not exist', () => {
    expect(getIsoDateFromParts(2020, 1, 2)).toBe('2020-01-02')
    expect(getIsoDateFromParts(2024, 2, 29)).toBe('2024-02-29')
    expect(getIsoDateFromParts(2023, 2, 29)).toBeNull()
    // `Pacific/Apia` had no 2011-12-30, but the ISO date exists.
    expect(getIsoDateFromParts(2011, 12, 30)).toBe('2011-12-30')
    expect(getIsoDateFromParts(2026, 13, 1)).toBeNull()
  })
})

describe('isIsoDate / getIsoToday', () => {
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

  it('getIsoToday returns a valid local ISO date', () => {
    expect(isIsoDate(getIsoToday())).toBe(true)
  })
})

/**
 * 2026-06-12 is a Friday; 2026-06-14 a Sunday.
 */
describe('getWeekStart', () => {
  it('finds the first day of the week for each week start', () => {
    expect(getWeekStart('2026-06-12', 1)).toBe('2026-06-08')
    expect(getWeekStart('2026-06-12', 0)).toBe('2026-06-07')
    expect(getWeekStart('2026-06-12', 6)).toBe('2026-06-06')
  })

  it('keeps a Sunday in its own Monday-first week', () => {
    expect(getWeekStart('2026-06-14', 1)).toBe('2026-06-08')
  })

  it('is a fixed point on the week-start day itself', () => {
    expect(getWeekStart('2026-06-08', 1)).toBe('2026-06-08')
    expect(getWeekStart('2026-06-07', 0)).toBe('2026-06-07')
    expect(getWeekStart('2026-06-13', 6)).toBe('2026-06-13')
  })
})

describe('year-months', () => {
  it('getYearMonth extracts the YYYY-MM year-month of an ISO date', () => {
    expect(getYearMonth('2026-06-09')).toBe('2026-06')
  })

  it('addMonthsToYearMonth moves across year boundaries in both directions', () => {
    expect(addMonthsToYearMonth('2026-12', 1)).toBe('2027-01')
    expect(addMonthsToYearMonth('2026-01', -1)).toBe('2025-12')
    expect(addMonthsToYearMonth('2026-06', 0)).toBe('2026-06')
  })

  it('getYearMonthsOfYear lists the twelve year-months', () => {
    expect(getYearMonthsOfYear(2026)).toEqual([
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
