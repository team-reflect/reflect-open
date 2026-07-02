import { describe, expect, it } from 'vitest'
import { createWeekWindow } from './calendar'
import { shouldRecenterWeeks } from './use-week-strip'

describe('shouldRecenterWeeks', () => {
  // 9 week slides around the anchor; margin 2 → indices 0–1 and 7–8 trigger.
  const window = createWeekWindow('2026-06-12', 'monday', 4)

  it('leaves the middle of the window alone', () => {
    expect(shouldRecenterWeeks(window, 4, 2)).toBe(false)
    expect(shouldRecenterWeeks(window, 2, 2)).toBe(false)
    expect(shouldRecenterWeeks(window, 6, 2)).toBe(false)
  })

  it('re-centers within the margin of either edge', () => {
    expect(shouldRecenterWeeks(window, 1, 2)).toBe(true)
    expect(shouldRecenterWeeks(window, 0, 2)).toBe(true)
    expect(shouldRecenterWeeks(window, 7, 2)).toBe(true)
    expect(shouldRecenterWeeks(window, 8, 2)).toBe(true)
  })
})
