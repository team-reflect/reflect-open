import {
  pickProviderTranscriptionConfig,
  type AiProvidersState,
  type TranscriptionConfig,
} from './provider-config'

/**
 * Which configured provider gets a given recording — decided from the
 * recording's *size on disk*, before any bytes are read or uploaded.
 *
 * Recordings are compressed containers (fMP4/WebM) and are **never split
 * client-side**: a byte-slice from the middle has no header, so no provider
 * can decode it. What varies between providers is how much they accept in
 * one piece, and that difference is the entire routing policy:
 *
 * - **OpenAI** caps its transcription endpoint at 25 MB per request, with no
 *   large-file mechanism behind it — a hard total budget.
 * - **Gemini** takes up to 2 GB through its Files API (see
 *   `ai/gemini-files`), far beyond the recording cap.
 *
 * The pure decision lives in {@link routeTranscription} so it can be tested
 * (and read) apart from the reconcile pass that applies it.
 */

/** OpenAI's documented per-request ceiling — also its total budget per recording. */
export const OPENAI_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024

/** The Files API per-file ceiling — Gemini's total budget per recording. */
export const GEMINI_FILE_MAX_BYTES = 2 * 1024 * 1024 * 1024

/** The largest recording `provider` can transcribe at all. */
export function transcriptionByteLimit(provider: TranscriptionConfig['provider']): number {
  return provider === 'openai' ? OPENAI_TRANSCRIPTION_MAX_BYTES : GEMINI_FILE_MAX_BYTES
}

/**
 * The configured entry that should transcribe a recording of
 * `recordingBytes`, or `null` when none can. The preferred entry wins
 * whenever the recording fits its provider's budget; one that doesn't fit
 * falls through to a configured Google entry (the only provider whose
 * budget covers meeting-length audio).
 *
 * `null` means *skip, don't tombstone*: the recording is fine, the
 * configuration just can't take it yet — the caller leaves the memo pending
 * and surfaces that adding a Gemini model would transcribe it.
 */
export function routeTranscription(
  state: AiProvidersState,
  preferred: TranscriptionConfig,
  recordingBytes: number,
): TranscriptionConfig | null {
  if (recordingBytes <= transcriptionByteLimit(preferred.provider)) {
    return preferred
  }
  const google =
    preferred.provider === 'google'
      ? preferred
      : pickProviderTranscriptionConfig(state, 'google')
  if (google !== null && recordingBytes <= transcriptionByteLimit(google.provider)) {
    return google
  }
  return null
}
