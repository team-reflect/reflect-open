import { describe, expect, it } from 'vitest'
import {
  addDaysIso,
  formatDayLabel,
  formatFullDate,
  formatRecencyLabel,
  formatTimeOfDay,
  isIsoDate,
  todayIso,
} from './dates'

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

  it('formatDayLabel renders the V1 daily-subject format per the date format', () => {
    expect(formatDayLabel('2026-06-09', 'mdy')).toBe('Tue, June 9th, 2026')
    expect(formatDayLabel('2026-06-09', 'dmy')).toBe('Tue, 9th June, 2026')
    expect(formatDayLabel('2026-05-31', 'mdy')).toBe('Sun, May 31st, 2026')
  })

  it('formatFullDate spells the date out per the date format', () => {
    expect(formatFullDate(new Date(2026, 5, 10), 'mdy')).toBe('June 10th, 2026')
    expect(formatFullDate(new Date(2026, 5, 10), 'dmy')).toBe('10th June, 2026')
    expect(formatFullDate(new Date(2026, 0, 1), 'mdy')).toBe('January 1st, 2026')
    expect(formatFullDate(new Date(2026, 0, 22), 'dmy')).toBe('22nd January, 2026')
  })

  describe('formatTimeOfDay', () => {
    it('renders 12-hour times with lowercase am/pm', () => {
      expect(formatTimeOfDay(new Date(2026, 5, 10, 20, 22), '12h')).toBe('8:22pm')
      expect(formatTimeOfDay(new Date(2026, 5, 10, 9, 5), '12h')).toBe('9:05am')
      expect(formatTimeOfDay(new Date(2026, 5, 10, 0, 0), '12h')).toBe('12:00am')
    })

    it('renders 24-hour times zero-padded', () => {
      expect(formatTimeOfDay(new Date(2026, 5, 10, 20, 22), '24h')).toBe('20:22')
      expect(formatTimeOfDay(new Date(2026, 5, 10, 9, 5), '24h')).toBe('09:05')
      expect(formatTimeOfDay(new Date(2026, 5, 10, 0, 0), '24h')).toBe('00:00')
    })
  })

  describe('formatRecencyLabel', () => {
    // Wednesday, June 10 2026, 9:00pm local.
    const now = new Date(2026, 5, 10, 21, 0)
    const mdy = { timeFormat: '12h', dateFormat: 'mdy' } as const
    const dmy = { timeFormat: '24h', dateFormat: 'dmy' } as const

    it('shows the time for a timestamp today, honoring the time format', () => {
      expect(formatRecencyLabel(new Date(2026, 5, 10, 20, 22).getTime(), mdy, now)).toBe('8:22pm')
      expect(formatRecencyLabel(new Date(2026, 5, 10, 9, 5).getTime(), mdy, now)).toBe('9:05am')
      expect(formatRecencyLabel(new Date(2026, 5, 10, 20, 22).getTime(), dmy, now)).toBe('20:22')
      expect(formatRecencyLabel(new Date(2026, 5, 10, 9, 5).getTime(), dmy, now)).toBe('09:05')
    })

    it('shows the weekday within the current week', () => {
      expect(formatRecencyLabel(new Date(2026, 5, 8, 13, 0).getTime(), mdy, now)).toBe('Mon')
      expect(formatRecencyLabel(new Date(2026, 5, 8, 13, 0).getTime(), dmy, now)).toBe('Mon')
    })

    it('shows the short date beyond the current week, honoring the date format', () => {
      expect(formatRecencyLabel(new Date(2026, 5, 3, 13, 0).getTime(), mdy, now)).toBe('6/3/2026')
      expect(formatRecencyLabel(new Date(2026, 5, 3, 13, 0).getTime(), dmy, now)).toBe('3/6/2026')
      expect(formatRecencyLabel(new Date(2025, 11, 31, 13, 0).getTime(), mdy, now)).toBe(
        '12/31/2025',
      )
      expect(formatRecencyLabel(new Date(2025, 11, 31, 13, 0).getTime(), dmy, now)).toBe(
        '31/12/2025',
      )
    })
  })
})
