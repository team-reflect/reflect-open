import { describe, expect, it } from 'vitest'
import { AUDIO_MEMO_MAX_DURATION_MS } from '@reflect/core'
import { audioMemoCapWarning, formatRecordingElapsed } from './recording-time'

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

describe('audioMemoCapWarning', () => {
  it('stays silent until the last ten minutes', () => {
    expect(audioMemoCapWarning(0)).toBeNull()
    expect(audioMemoCapWarning(AUDIO_MEMO_MAX_DURATION_MS - 11 * 60_000)).toBeNull()
  })

  it('counts down whole minutes near the cap', () => {
    expect(audioMemoCapWarning(AUDIO_MEMO_MAX_DURATION_MS - 10 * 60_000)).toBe('Stops in 10m')
    expect(audioMemoCapWarning(AUDIO_MEMO_MAX_DURATION_MS - 3 * 60_000 + 1)).toBe('Stops in 3m')
  })

  it('counts down seconds inside the final minute', () => {
    expect(audioMemoCapWarning(AUDIO_MEMO_MAX_DURATION_MS - 30_000)).toBe('Stops in 30s')
    expect(audioMemoCapWarning(AUDIO_MEMO_MAX_DURATION_MS - 500)).toBe('Stops in 1s')
  })
})
