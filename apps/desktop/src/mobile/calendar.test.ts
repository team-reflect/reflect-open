import { describe, expect, it } from 'vitest'
import { monthLabel, weekOf } from './calendar'

/**
 * 2026-06-12 is a Friday; 2026-06-14 a Sunday — fixed anchors for the
 * week-start math.
 */
describe('weekOf', () => {
  it('builds a Monday-first week containing the date', () => {
    const week = weekOf('2026-06-12', 'monday')
    expect(week).toEqual([
      '2026-06-08',
      '2026-06-09',
      '2026-06-10',
      '2026-06-11',
      '2026-06-12',
      '2026-06-13',
      '2026-06-14',
    ])
  })

  it('builds a Sunday-first week containing the date', () => {
    const week = weekOf('2026-06-12', 'sunday')
    expect(week[0]).toBe('2026-06-07')
    expect(week[6]).toBe('2026-06-13')
    expect(week).toContain('2026-06-12')
  })

  it('keeps a Sunday in its own Monday-first week (the wrap edge)', () => {
    // 2026-06-14 is a Sunday: a Monday-first week runs Mon 06-08 … Sun 06-14.
    expect(weekOf('2026-06-14', 'monday')).toEqual([
      '2026-06-08',
      '2026-06-09',
      '2026-06-10',
      '2026-06-11',
      '2026-06-12',
      '2026-06-13',
      '2026-06-14',
    ])
  })

  it('spans the year boundary without skipping or repeating a day', () => {
    // 2026-01-01 is a Thursday: a Monday-first week reaches back into 2025.
    const week = weekOf('2026-01-01', 'monday')
    expect(week[0]).toBe('2025-12-29')
    expect(week[6]).toBe('2026-01-04')
    expect(week).toContain('2026-01-01')
  })
})

describe('monthLabel', () => {
  it('formats the month and year', () => {
    expect(monthLabel('2026-06-12')).toBe('June 2026')
  })
})
