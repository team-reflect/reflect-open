import { describe, expect, it } from 'vitest'
import {
  CAROUSEL_RADIUS,
  carouselDateAt,
  carouselIndexOf,
  carouselWindow,
  monthLabel,
  weekOf,
} from './calendar'

/**
 * 2026-06-12 is a Friday; 2026-06-15 a Monday, 2026-06-14 a Sunday — fixed
 * anchors for the week-start math.
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
})

describe('monthLabel', () => {
  it('formats the month and year', () => {
    expect(monthLabel('2026-06-12')).toBe('June 2026')
  })
})

describe('carousel window', () => {
  it('centers the anchor and round-trips index↔date', () => {
    const window = carouselWindow('2026-06-12')
    expect(window.count).toBe(CAROUSEL_RADIUS * 2 + 1)
    const center = carouselIndexOf(window, '2026-06-12')
    expect(center).toBe(CAROUSEL_RADIUS)
    expect(carouselDateAt(window, center)).toBe('2026-06-12')
  })

  it('returns -1 for a date outside the window', () => {
    const window = carouselWindow('2026-06-12')
    expect(carouselIndexOf(window, '2025-01-01')).toBe(-1)
  })

})
