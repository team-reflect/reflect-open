import { describe, expect, it } from 'vitest'
import {
  addDaysIso,
  addMonthsIso,
  isCalendarDate,
  isIsoDate,
  isoFromParts,
  weekdayIso,
} from './dates.ts'

describe('addDaysIso', () => {
  it('adds and subtracts calendar days across month and year boundaries', () => {
    expect(addDaysIso('2020-01-01', -1)).toBe('2019-12-31')
    expect(addDaysIso('2020-02-28', 1)).toBe('2020-02-29') // leap year
    expect(addDaysIso('2021-02-28', 1)).toBe('2021-03-01')
    expect(addDaysIso('2020-01-01', 0)).toBe('2020-01-01')
  })

  it('keeps years 0-99', () => {
    expect(addDaysIso('0099-01-01', -1)).toBe('0098-12-31')
    expect(addDaysIso('0000-02-28', 1)).toBe('0000-02-29')
  })

  it('is DST-safe (a spring-forward day still advances by one calendar day)', () => {
    // 2020-03-08 is the US spring-forward day; UTC math never skips it.
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

describe('isoFromParts', () => {
  it('zero-pads year, month, and day', () => {
    expect(isoFromParts(2020, 1, 2)).toBe('2020-01-02')
    expect(isoFromParts(23, 6, 5)).toBe('0023-06-05')
  })
})

describe('isCalendarDate / isIsoDate', () => {
  it('accepts real days and rejects impossible ones', () => {
    expect(isCalendarDate('2024-02-29')).toBe(true)
    expect(isCalendarDate('2023-02-29')).toBe(false)
    expect(isCalendarDate('2026-02-31')).toBe(false)
    expect(isCalendarDate('2026-13-01')).toBe(false)
  })

  it('keeps years 0-99', () => {
    // Year 0 is a leap year (divisible by 400) even though 1900 is not.
    expect(isCalendarDate('0099-12-31')).toBe(true)
    expect(isCalendarDate('0000-02-29')).toBe(true)
  })

  it('isIsoDate also enforces the YYYY-MM-DD shape', () => {
    expect(isIsoDate('2020-01-01')).toBe(true)
    expect(isIsoDate('2020-1-1')).toBe(false)
    expect(isIsoDate('not-a-date')).toBe(false)
    expect(isIsoDate('2026-02-31')).toBe(false)
  })
})
