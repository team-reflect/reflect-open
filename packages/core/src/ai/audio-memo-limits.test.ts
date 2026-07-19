import { describe, expect, it } from 'vitest'
import {
  AUDIO_MEMO_CAP_WARNING_MS,
  AUDIO_MEMO_MAX_DURATION_MS,
  audioMemoCapWarning,
} from './audio-memo-limits'

describe('audioMemoCapWarning', () => {
  it('stays silent while the cap is comfortably far', () => {
    expect(audioMemoCapWarning(0)).toBeNull()
    expect(
      audioMemoCapWarning(AUDIO_MEMO_MAX_DURATION_MS - AUDIO_MEMO_CAP_WARNING_MS - 1),
    ).toBeNull()
  })

  it('counts down in minutes inside the warning window', () => {
    expect(audioMemoCapWarning(AUDIO_MEMO_MAX_DURATION_MS - AUDIO_MEMO_CAP_WARNING_MS)).toBe(
      'Stops in 10m',
    )
    expect(audioMemoCapWarning(AUDIO_MEMO_MAX_DURATION_MS - 3 * 60_000)).toBe('Stops in 3m')
  })

  it('switches to seconds in the final minute — never a stuck "1m"', () => {
    expect(audioMemoCapWarning(AUDIO_MEMO_MAX_DURATION_MS - 59_000)).toBe('Stops in 59s')
    expect(audioMemoCapWarning(AUDIO_MEMO_MAX_DURATION_MS - 5_000)).toBe('Stops in 5s')
    expect(audioMemoCapWarning(AUDIO_MEMO_MAX_DURATION_MS)).toBe('Stops in 1s')
  })
})
