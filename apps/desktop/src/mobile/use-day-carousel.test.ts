import { describe, expect, it } from 'vitest'
import { createDayWindow } from '@/lib/day-window'
import { reconcileCarousel, shouldRecenter, type ReconcileInput } from './use-day-carousel'

/**
 * The carousel's follow-the-route decision in isolation — Embla pointer
 * gestures can't be driven under jsdom, so the branchy reconciliation that the
 * integration test can only reach indirectly is pinned here as pure logic.
 */
const base: ReconcileInput = {
  index: 10,
  windowStart: '2025-06-11',
  lastWindowStart: '2025-06-11',
  date: '2026-06-12',
  reported: '2026-06-01',
}

describe('reconcileCarousel', () => {
  it('scrolls for an ordinary in-window jump', () => {
    expect(reconcileCarousel(base)).toEqual({ action: 'scroll', index: 10 })
  })

  it('does nothing for the echo of our own swipe', () => {
    // The route just echoed back the day we reported — re-scrolling would
    // cancel Embla's settling animation.
    expect(reconcileCarousel({ ...base, date: '2026-06-01', reported: '2026-06-01' })).toEqual({
      action: 'none',
    })
  })

  it('does nothing when the date is outside the window (a re-anchor is pending)', () => {
    expect(reconcileCarousel({ ...base, index: -1 })).toEqual({ action: 'none' })
  })

  it('reinitializes when the window was re-anchored', () => {
    expect(reconcileCarousel({ ...base, lastWindowStart: '2024-01-01' })).toEqual({
      action: 'reinit',
      index: 10,
    })
  })

  it('reinitializes after a re-anchor even when the date matches the last report', () => {
    // A far date link re-anchors *and* is later echoed back: the window change
    // must win over the echo guard, or the rebuilt slides never get shown.
    expect(
      reconcileCarousel({
        ...base,
        lastWindowStart: '2024-01-01',
        date: '2026-06-01',
        reported: '2026-06-01',
      }),
    ).toEqual({ action: 'reinit', index: 10 })
  })

  it('treats an outside date as a no-op even while the window is mid-re-anchor', () => {
    // `index === -1` is checked first: the window effect will rebuild before
    // this reconciliation matters, so there is nothing to scroll yet.
    expect(reconcileCarousel({ ...base, index: -1, lastWindowStart: '2024-01-01' })).toEqual({
      action: 'none',
    })
  })
})

describe('shouldRecenter', () => {
  // 21 slides around the anchor; margin 5 → indices 0–4 and 16–20 trigger.
  const window = createDayWindow('2026-06-12', { past: 10, future: 10 })

  it('leaves the middle of the window alone', () => {
    expect(shouldRecenter(window, 10, 5)).toBe(false)
    expect(shouldRecenter(window, 5, 5)).toBe(false)
    expect(shouldRecenter(window, 15, 5)).toBe(false)
  })

  it('re-centers within the margin of either edge', () => {
    expect(shouldRecenter(window, 4, 5)).toBe(true)
    expect(shouldRecenter(window, 0, 5)).toBe(true)
    expect(shouldRecenter(window, 16, 5)).toBe(true)
    expect(shouldRecenter(window, 20, 5)).toBe(true)
  })
})
