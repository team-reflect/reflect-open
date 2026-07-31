import { AUDIO_MEMO_MAX_DURATION_MS } from '@reflect/core'

/**
 * How close to the cap the recording UI starts warning that the recording
 * will stop. Far from it, the cap is invisible — almost nobody hits it, and
 * a permanent label would be noise.
 */
const CAP_WARNING_MS = 10 * 60_000

/** `m:ss` under an hour, `h:mm:ss` from there — meeting-length sessions. */
export function formatRecordingElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const paddedSeconds = String(seconds).padStart(2, '0')
  if (hours === 0) {
    return `${minutes}:${paddedSeconds}`
  }
  return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`
}

/**
 * The recording UI's near-cap warning (`Stops in 3m`), or `null` while the
 * cap is comfortably far — the auto-stop must never surprise, but a
 * permanent label would be noise.
 */
export function audioMemoCapWarning(elapsedMs: number): string | null {
  const remainingMs = AUDIO_MEMO_MAX_DURATION_MS - elapsedMs
  if (remainingMs > CAP_WARNING_MS) {
    return null
  }
  if (remainingMs < 60_000) {
    // Whole minutes would read "1m" for the entire final minute — switch to
    // seconds so the label tracks the actual stop.
    return `Stops in ${Math.max(1, Math.ceil(remainingMs / 1000))}s`
  }
  return `Stops in ${Math.ceil(remainingMs / 60_000)}m`
}
