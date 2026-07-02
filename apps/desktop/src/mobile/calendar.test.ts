import { describe, expect, it } from 'vitest'
import {
  createWeekWindow,
  monthLabel,
  weekAtIndex,
  weekIndexOf,
  weekOf,
  weekStartOf,
} from './calendar'

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

describe('weekStartOf', () => {
  it('finds the Monday of a mid-week date', () => {
    expect(weekStartOf('2026-06-12', 'monday')).toBe('2026-06-08')
  })

  it('keeps a Sunday in its own Monday-first week', () => {
    expect(weekStartOf('2026-06-14', 'monday')).toBe('2026-06-08')
  })

  it('finds the Sunday of a Sunday-first week', () => {
    expect(weekStartOf('2026-06-12', 'sunday')).toBe('2026-06-07')
  })

  it('is a fixed point on the week-start day itself', () => {
    expect(weekStartOf('2026-06-08', 'monday')).toBe('2026-06-08')
    expect(weekStartOf('2026-06-07', 'sunday')).toBe('2026-06-07')
  })
})

describe('week windows', () => {
  const window = createWeekWindow('2026-06-12', 'monday', 4)

  it('centers the anchor date’s week', () => {
    expect(window).toEqual({ start: '2026-05-11', count: 9, anchorIndex: 4 })
    expect(weekAtIndex(window, window.anchorIndex)).toBe('2026-06-08')
  })

  it('maps indices to week starts and back', () => {
    expect(weekAtIndex(window, 0)).toBe('2026-05-11')
    expect(weekAtIndex(window, 8)).toBe('2026-07-06')
    expect(weekIndexOf(window, '2026-06-14', 'monday')).toBe(4) // Sunday, same week
    expect(weekIndexOf(window, '2026-05-11', 'monday')).toBe(0)
    expect(weekIndexOf(window, '2026-07-12', 'monday')).toBe(8)
  })

  it('reports -1 for dates beyond the window', () => {
    expect(weekIndexOf(window, '2026-05-10', 'monday')).toBe(-1)
    expect(weekIndexOf(window, '2026-07-13', 'monday')).toBe(-1)
  })

  it('reports -1 when the week-start setting no longer aligns (rebuild signal)', () => {
    // The window's weeks start on Mondays; a Sunday-first lookup lands
    // mid-week and must force a rebuild rather than mislabel slides.
    expect(weekIndexOf(window, '2026-06-12', 'sunday')).toBe(-1)
  })
})
