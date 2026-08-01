/** Practical product limit for one logical audio memo: four hours covers most meetings. */
export const AUDIO_MEMO_MAX_DURATION_MS = 4 * 60 * 60_000

/** Raw chunk budget below provider request limits; used before calls to avoid 413s. */
export const AUDIO_TRANSCRIPTION_SEGMENT_BYTES = 4 * 1024 * 1024

/** User-facing label for the intentional recording cap. */
export const AUDIO_MEMO_MAX_DURATION_LABEL = '4 hours'
