import { describe, expect, it } from 'vitest'
import { formatElapsed } from './durations.ts'

describe('formatElapsed', () => {
  it('formats sub-hour times as m:ss', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(65_000)).toBe('1:05')
    expect(formatElapsed(59 * 60_000 + 59_000)).toBe('59:59')
  })

  it('switches to h:mm:ss from one hour', () => {
    expect(formatElapsed(60 * 60_000)).toBe('1:00:00')
    expect(formatElapsed(2 * 60 * 60_000 + 3 * 60_000 + 4_000)).toBe('2:03:04')
    expect(formatElapsed(24 * 60 * 60_000)).toBe('24:00:00')
  })
})
