import { describe, expect, it } from 'vitest'
import { formatRecordingElapsed } from './recording-time'

describe('formatRecordingElapsed', () => {
  it('formats sub-hour times as m:ss', () => {
    expect(formatRecordingElapsed(0)).toBe('0:00')
    expect(formatRecordingElapsed(65_000)).toBe('1:05')
    expect(formatRecordingElapsed(59 * 60_000 + 59_000)).toBe('59:59')
  })

  it('switches to h:mm:ss from one hour', () => {
    expect(formatRecordingElapsed(60 * 60_000)).toBe('1:00:00')
    expect(formatRecordingElapsed(2 * 60 * 60_000 + 3 * 60_000 + 4_000)).toBe('2:03:04')
  })
})
