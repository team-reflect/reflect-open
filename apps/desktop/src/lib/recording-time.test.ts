import { describe, expect, it } from 'vitest'
import { formatRecordingElapsed } from './recording-time'

describe('formatRecordingElapsed', () => {
  it('keeps the compact m:ss form under an hour', () => {
    expect(formatRecordingElapsed(0)).toBe('0:00')
    expect(formatRecordingElapsed(65_000)).toBe('1:05')
    expect(formatRecordingElapsed(59 * 60_000 + 59_000)).toBe('59:59')
  })

  it('rolls into h:mm:ss once an hour is reached — never a 183-minute display', () => {
    expect(formatRecordingElapsed(60 * 60_000)).toBe('1:00:00')
    expect(formatRecordingElapsed(3 * 60 * 60_000 + 3 * 60_000 + 42_000)).toBe('3:03:42')
  })
})
