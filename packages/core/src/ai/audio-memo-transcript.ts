import type { AudioMemoEnrichmentCredentials } from './audio-memo-title'
import { generateAudioMemoTitle } from './audio-memo-title'
import { formatAudioMemoTranscript } from './audio-memo-format'

/**
 * Best-effort enrichment of one session's stitched transcript: an optional
 * formatting pass and a content-derived title. Enrichment never gates the
 * transcript — every failure path falls back to the raw text and the
 * timestamp title, because the transcript is already durable by the time
 * this runs.
 */

/**
 * Past this the formatting model reliably times out or fails the verbatim
 * equivalence check (`retainsTranscriptContent`), so the call would be paid
 * and then discarded. Roughly forty minutes of speech.
 */
export const FORMAT_MAX_CHARS = 24_000

/**
 * A title needs the opening of the meeting, not its entirety — and capping
 * the input keeps the title call's cost flat no matter how long the session
 * ran.
 */
export const TITLE_INPUT_MAX_CHARS = 4_000

export interface EnrichSessionTranscriptInput {
  /** The stitched, non-empty session transcript. */
  readonly transcript: string
  /** Small-model credentials for formatting and naming; `null` skips both. */
  readonly enrichmentCredentials: AudioMemoEnrichmentCredentials | null
  /** Whether the combined formatting-and-naming pass is enabled. */
  readonly formatTranscript: boolean
  /** Timestamp-derived title used when enrichment cannot name the memo. */
  readonly fallbackTitle: string
  /** Host transport (the Tauri HTTP plugin's fetch; tests pass a stub). */
  readonly fetchFn?: typeof fetch | undefined
}

export interface EnrichedSessionTranscript {
  readonly title: string
  readonly body: string
}

export async function enrichSessionTranscript(
  input: EnrichSessionTranscriptInput,
): Promise<EnrichedSessionTranscript> {
  if (
    input.formatTranscript &&
    input.enrichmentCredentials !== null &&
    input.transcript.length <= FORMAT_MAX_CHARS
  ) {
    const formatted = await formatAudioMemoTranscript({
      credentials: input.enrichmentCredentials,
      fetchFn: input.fetchFn,
      transcript: input.transcript,
      fallbackTitle: input.fallbackTitle,
    })
    return { title: formatted.title, body: formatted.body }
  }
  const title = await generateAudioMemoTitle({
    ...(input.enrichmentCredentials !== null
      ? { credentials: input.enrichmentCredentials }
      : {}),
    fetchFn: input.fetchFn,
    transcript: input.transcript.slice(0, TITLE_INPUT_MAX_CHARS),
    fallbackTitle: input.fallbackTitle,
  })
  return { title, body: input.transcript }
}
