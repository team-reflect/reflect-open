import { errorMessage } from '../errors'
import type { TranscriptionConfig } from './provider-config'
import type { AudioMemoEnrichmentCredentials } from './audio-memo-title'
import { generateAudioMemoTitle } from './audio-memo-title'
import { formatAudioMemoTranscript } from './audio-memo-format'
import { APP_REVIEW_STUB_KEY, stubTranscriptBody } from './audio-memo-review-stub'
import { isTranscriptionRejected, transcribeAudio } from './transcribe'

export interface BuildAudioMemoTranscriptInput {
  /** The recording bytes read back from the graph. */
  readonly audio: Blob
  /** Stored MIME type paired with the recording bytes. */
  readonly mimeType: string
  /** Fixed transcription provider and its configured entry. */
  readonly config: TranscriptionConfig
  /** Transcription-provider key read from the OS keychain. */
  readonly apiKey: string
  /** Small-model credentials for formatting and content-derived naming. */
  readonly enrichmentCredentials: AudioMemoEnrichmentCredentials | null
  /** Whether to run the combined formatting and naming pass. */
  readonly formatTranscript: boolean
  /** Timestamp-derived title used when speech or enrichment cannot name the memo. */
  readonly fallbackTitle: string
  /** Host transport (the Tauri HTTP plugin's fetch; tests pass a stub). */
  readonly fetchFn?: typeof fetch | undefined
  /** Abort gate checked between speech-to-text and optional enrichment. */
  readonly isStale?: (() => boolean) | undefined
}

export interface BuiltAudioMemoTranscript {
  readonly status: 'ready'
  /** Markdown stored as the memo note's body. */
  readonly body: string
  /** Title stored on the memo note and its daily-note backlink. */
  readonly title: string
  /** Whether the speech-to-text provider permanently refused the recording. */
  readonly rejected: boolean
}

export interface StaleAudioMemoTranscript {
  /** The graph session ended after speech-to-text, before optional enrichment. */
  readonly status: 'stale'
}

export type BuildAudioMemoTranscriptOutcome =
  | BuiltAudioMemoTranscript
  | StaleAudioMemoTranscript

/**
 * Build one memo's note content from its durable recording. Speech-to-text
 * failures remain retryable except for provider refusal; optional enrichment
 * is best-effort and falls back to the raw transcript internally.
 */
export async function buildAudioMemoTranscript(
  input: BuildAudioMemoTranscriptInput,
): Promise<BuildAudioMemoTranscriptOutcome> {
  if (input.apiKey === APP_REVIEW_STUB_KEY) {
    return {
      status: 'ready',
      body: stubTranscriptBody(),
      title: input.fallbackTitle,
      rejected: false,
    }
  }

  try {
    const text = await transcribeAudio({
      provider: input.config.provider,
      apiKey: input.apiKey,
      audio: input.audio,
      mimeType: input.mimeType,
      fetchFn: input.fetchFn,
    })
    if (input.isStale?.() === true) {
      return { status: 'stale' }
    }
    if (text === '') {
      return {
        status: 'ready',
        body: 'No speech detected.',
        title: input.fallbackTitle,
        rejected: false,
      }
    }
    if (input.formatTranscript && input.enrichmentCredentials !== null) {
      const formatted = await formatAudioMemoTranscript({
        credentials: input.enrichmentCredentials,
        fetchFn: input.fetchFn,
        transcript: text,
        fallbackTitle: input.fallbackTitle,
      })
      return {
        status: 'ready',
        body: formatted.body,
        title: formatted.title,
        rejected: false,
      }
    }
    const title = await generateAudioMemoTitle({
      ...(input.enrichmentCredentials !== null
        ? { credentials: input.enrichmentCredentials }
        : {}),
      fetchFn: input.fetchFn,
      transcript: text,
      fallbackTitle: input.fallbackTitle,
    })
    return { status: 'ready', body: text, title, rejected: false }
  } catch (cause) {
    if (!isTranscriptionRejected(cause)) {
      throw cause
    }
    return {
      status: 'ready',
      body: `Transcription failed: ${errorMessage(cause)}`,
      title: input.fallbackTitle,
      rejected: true,
    }
  }
}
