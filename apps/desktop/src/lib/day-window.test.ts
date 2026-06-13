import { describe, expect, it } from 'vitest'
import {
  createDayWindow,
  dateAtIndex,
  indexOfDate,
  indexWithin,
  FUTURE_DAYS,
  PAST_DAYS,
} from './day-window'

describe('day window', () => {
  const window = createDayWindow('2026-06-09')

  it('anchors the window around the given day', () => {
    expect(window.count).toBe(PAST_DAYS + FUTURE_DAYS + 1)
    expect(dateAtIndex(window, window.anchorIndex)).toBe('2026-06-09')
    expect(dateAtIndex(window, 0)).toBe(window.start)
  })

  it('index↔date round-trips across the window', () => {
    for (const date of ['2026-06-09', '2026-06-10', '2026-01-01', '2027-06-01']) {
      expect(dateAtIndex(window, indexOfDate(window, date))).toBe(date)
    }
  })

  it('orders chronologically: past below the anchor index, future above', () => {
    expect(indexOfDate(window, '2026-06-08')).toBe(window.anchorIndex - 1)
    expect(indexOfDate(window, '2026-06-10')).toBe(window.anchorIndex + 1)
  })

  it('clamps out-of-window dates to the edges instead of erroring', () => {
    expect(indexOfDate(window, '1990-01-01')).toBe(0)
    expect(indexOfDate(window, '2099-01-01')).toBe(window.count - 1)
  })
})

describe('a symmetric (carousel) window', () => {
  const radius = 366
  const window = createDayWindow('2026-06-12', { past: radius, future: radius })

  it('centers the anchor and round-trips index↔date', () => {
    expect(window.count).toBe(radius * 2 + 1)
    expect(window.anchorIndex).toBe(radius)
    const center = indexWithin(window, '2026-06-12')
    expect(center).toBe(radius)
    expect(dateAtIndex(window, center)).toBe('2026-06-12')
  })

  it('reports the in-window edges, not a clamp', () => {
    expect(indexWithin(window, dateAtIndex(window, 0))).toBe(0)
    expect(indexWithin(window, dateAtIndex(window, window.count - 1))).toBe(window.count - 1)
  })
})

describe('indexWithin', () => {
  const window = createDayWindow('2026-06-12', { past: 366, future: 366 })

  it('returns -1 for a date outside the window (the re-anchor signal)', () => {
    expect(indexWithin(window, '2025-01-01')).toBe(-1)
    expect(indexWithin(window, '2028-01-01')).toBe(-1)
  })

  it('returns -1 one day past each edge', () => {
    expect(indexWithin(window, dateAtIndex(window, -1))).toBe(-1)
    expect(indexWithin(window, dateAtIndex(window, window.count))).toBe(-1)
  })
})
