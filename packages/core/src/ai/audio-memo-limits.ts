/**
 * Auto-stop cap for one recording: four hours covers most meetings. The cap
 * bounds what capture must durably hold, not what providers accept —
 * transcription size budgets live in `transcribe.ts` and route per provider.
 */
export const AUDIO_MEMO_MAX_DURATION_MS = 4 * 60 * 60_000

/**
 * How close to the cap the recording UI starts warning that the recording
 * will stop. Far from it, the cap is invisible — almost nobody hits it, and
 * a permanent label would be noise.
 */
export const AUDIO_MEMO_CAP_WARNING_MS = 10 * 60_000

/**
 * The recording UI's near-cap warning (`Stops in 3m`), or `null` while the
 * cap is comfortably far — the auto-stop must never surprise, but a
 * permanent label would be noise.
 */
export function audioMemoCapWarning(elapsedMs: number): string | null {
  const remainingMs = AUDIO_MEMO_MAX_DURATION_MS - elapsedMs
  if (remainingMs > AUDIO_MEMO_CAP_WARNING_MS) {
    return null
  }
  return `Stops in ${Math.max(1, Math.ceil(remainingMs / 60_000))}m`
}
