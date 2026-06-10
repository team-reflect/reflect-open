import { describe, expect, it } from 'vitest'
import { addDaysIso, formatDayLabel, formatRecencyLabel, isIsoDate, todayIso } from './dates'

describe('dates', () => {
  it('todayIso returns a valid local ISO date', () => {
    const today = todayIso()
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(isIsoDate(today)).toBe(true)
  })

  it('isIsoDate rejects malformed and impossible dates', () => {
    expect(isIsoDate('2026-06-09')).toBe(true)
    expect(isIsoDate('2026-6-9')).toBe(false)
    expect(isIsoDate('2026-13-01')).toBe(false)
    expect(isIsoDate('2026-02-31')).toBe(false)
    expect(isIsoDate('not a date')).toBe(false)
  })

  it('addDaysIso crosses month and year boundaries', () => {
    expect(addDaysIso('2026-06-09', 1)).toBe('2026-06-10')
    expect(addDaysIso('2026-06-09', -1)).toBe('2026-06-08')
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('formatDayLabel renders a readable day', () => {
    expect(formatDayLabel('2026-06-09')).toBe('Tuesday, June 9')
  })

  describe('formatRecencyLabel', () => {
    // Wednesday, June 10 2026, 9:00pm local.
    const now = new Date(2026, 5, 10, 21, 0)

    it('shows the time for a timestamp today', () => {
      expect(formatRecencyLabel(new Date(2026, 5, 10, 20, 22).getTime(), now)).toBe('8:22pm')
      expect(formatRecencyLabel(new Date(2026, 5, 10, 9, 5).getTime(), now)).toBe('9:05am')
    })

    it('shows the weekday within the current week', () => {
      expect(formatRecencyLabel(new Date(2026, 5, 8, 13, 0).getTime(), now)).toBe('Mon')
    })

    it('shows the short date beyond the current week', () => {
      expect(formatRecencyLabel(new Date(2026, 5, 3, 13, 0).getTime(), now)).toBe('6/3/2026')
      expect(formatRecencyLabel(new Date(2025, 11, 31, 13, 0).getTime(), now)).toBe('12/31/2025')
    })
  })
})
