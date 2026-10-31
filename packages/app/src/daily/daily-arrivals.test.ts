import { describe, expect, it } from 'vitest'
import { dailyArrivalIntent } from './daily-arrivals.ts'

describe('dailyArrivalIntent', () => {
  const last = { seq: 1, date: '2026-07-06' }

  it('does nothing while the seq stands still', () => {
    expect(dailyArrivalIntent(last, { seq: 1, date: '2026-07-07' }, true)).toEqual({
      focus: 'keep',
      reanchor: false,
    })
  })

  it('re-anchors on a date-preserving re-arrival', () => {
    expect(dailyArrivalIntent(last, { seq: 2, date: '2026-07-06' }, false)).toEqual({
      focus: 'clear',
      reanchor: true,
    })
  })

  it('requests focus on a capture re-arrival, and still re-anchors', () => {
    expect(dailyArrivalIntent(last, { seq: 2, date: '2026-07-06' }, true)).toEqual({
      focus: 'request',
      reanchor: true,
    })
  })

  it('ignores a swipe echo (the date moved with the seq)', () => {
    expect(dailyArrivalIntent(last, { seq: 2, date: '2026-07-07' }, false)).toEqual({
      focus: 'clear',
      reanchor: false,
    })
  })
})
