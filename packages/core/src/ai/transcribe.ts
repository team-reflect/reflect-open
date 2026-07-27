import { z } from 'zod'
import { bytesToBase64 } from '../lib/base64'
import { ReflectError } from '../errors'
import type { TranscriptionProvider } from './provider-config'
import {
  httpError,
  safeJson,
  send,
  TranscriptionOversizeError,
  TranscriptionRejectedError,
  TRANSCRIPTION_TRANSFER_TIMEOUT_MS,
} from './transcribe-http'

/**
 * BYOK audio transcription (audio memos): one segment-sized recording in,
 * plain text out. OpenAI is served by its dedicated transcription endpoint,
 * Gemini by a `generateContent` call with inline audio. Both run on fixed
 * transcription models — the configured entry only picks the provider and
 * key (see `pickTranscriptionConfig`); chat-model choices don't transfer
 * because chat models can't take this endpoint (OpenAI) or would bill
 * pro-tier rates for speech-to-text (Gemini). The shared HTTP substrate
 * (stale gate, timeouts, error ladder) is `ai/transcribe-http`.
 */

export const OPENAI_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe'

/**
 * Retried once when the primary model is missing on the key — project-scoped
 * OpenAI keys can expose `whisper-1` but not the 4o transcription models.
 */
export const OPENAI_TRANSCRIPTION_FALLBACK_MODEL = 'whisper-1'

export const GOOGLE_TRANSCRIPTION_MODEL = 'gemini-3.5-flash'

/**
 * Retried once when the primary model 404s. Google retires models on a short
 * clock (the spike caught `gemini-3-pro-preview` dying within months of
 * release), and a retired transcription model must degrade, not hard-fail.
 */
export const GOOGLE_TRANSCRIPTION_FALLBACK_MODEL = 'gemini-2.5-flash'

export interface TranscriptionRequest {
  provider: TranscriptionProvider
  apiKey: string
  /** The recording, as MediaRecorder produced it. */
  audio: Blob
  /** The recording's MIME type, possibly with codec parameters. */
  mimeType: string
  /**
   * Host transport — the desktop app passes the Tauri HTTP plugin's fetch
   * (CORS-free); `@reflect/core` itself stays platform-agnostic.
   */
  fetchFn?: typeof fetch | undefined
  /**
   * Abort gate consulted before every provider call — a graph switch
   * mid-pass must not bill another call. Firing reads as a retryable
   * `network` error.
   */
  isStale?: (() => boolean) | undefined
}

/**
 * Transcribe one recording, returning the trimmed transcript (empty when the
 * provider heard nothing). Throws {@link ReflectError}: `auth` when the key is
 * rejected, `network` when the call can't complete, `parse` when the response
 * shape is unrecognizable.
 */
export async function transcribeAudio(request: TranscriptionRequest): Promise<string> {
  return request.provider === 'openai'
    ? transcribeWithOpenAi(request)
    : transcribeWithGemini(request)
}

/** `audio/webm;codecs=opus` → `audio/webm` — parameters confuse provider sniffing. */
export function baseMimeType(mimeType: string): string {
  return (mimeType.split(';')[0] ?? mimeType).trim().toLowerCase()
}

/**
 * File extension per audio MIME type — shared by the provider upload filename
 * and the on-disk naming of saved memos (`actions/audio-memo`), which must
 * agree so a stored recording round-trips back into transcription.
 */
export const AUDIO_EXTENSION_BY_MIME: Record<string, string> = {
  // An audio-only MP4 *is* an M4A — and whisper-1 sniffs by extension, so a
  // WKWebView recording named `.mp4` is rejected while `.m4a` is accepted.
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
}

function uploadFilename(mimeType: string): string {
  return `memo.${AUDIO_EXTENSION_BY_MIME[baseMimeType(mimeType)] ?? 'm4a'}`
}


const openAiResponseSchema = z.object({ text: z.string() })

function isModelNotFound(body: string): boolean {
  const parsed = z
    .object({ error: z.object({ code: z.string().nullable() }) })
    .safeParse(safeJson(body))
  return parsed.success && parsed.data.error.code === 'model_not_found'
}

async function transcribeWithOpenAi(request: TranscriptionRequest): Promise<string> {
  const fetchFn = request.fetchFn ?? fetch
  const attempt = (model: string): Promise<Response> => {
    const form = new FormData()
    form.append('file', request.audio, uploadFilename(request.mimeType))
    form.append('model', model)
    return send(
      fetchFn,
      'https://api.openai.com/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${request.apiKey}` },
        body: form,
      },
      { timeoutMs: TRANSCRIPTION_TRANSFER_TIMEOUT_MS, isStale: request.isStale },
    )
  }

  let response = await attempt(OPENAI_TRANSCRIPTION_MODEL)
  let body = await response.text()
  if (!response.ok && isModelNotFound(body)) {
    response = await attempt(OPENAI_TRANSCRIPTION_FALLBACK_MODEL)
    body = await response.text()
  }
  if (!response.ok) {
    throw httpError('openai', response.status, body)
  }

  const parsed = openAiResponseSchema.safeParse(safeJson(body))
  if (!parsed.success) {
    throw new ReflectError('parse', `unrecognized openai transcription response: ${body.slice(0, 200)}`)
  }
  return parsed.data.text.trim()
}

const geminiResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        finishReason: z.string().optional(),
        content: z
          .object({
            parts: z.array(z.object({ text: z.string().optional() })).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
})

const GEMINI_INSTRUCTION =
  'Transcribe this audio recording verbatim. Return only the transcribed text, with no commentary or formatting.'

/**
 * Raw-audio budget for a Gemini inline request: the whole JSON body must
 * stay under Gemini's ~20 MB request cap, and inline audio rides it
 * base64-encoded (~1.33×). Rotation-sized segments fit comfortably; this
 * only fires when an encoder ignored the bitrate hint, and skipping beats
 * letting the provider 400 the request into a tombstone.
 */
export const GEMINI_INLINE_MAX_BYTES = 12 * 1024 * 1024

async function transcribeWithGemini(request: TranscriptionRequest): Promise<string> {
  if (request.audio.size > GEMINI_INLINE_MAX_BYTES) {
    throw new TranscriptionOversizeError(
      `the recording does not fit a gemini inline request (${request.audio.size} bytes)`,
    )
  }
  const fetchFn = request.fetchFn ?? fetch
  const data = bytesToBase64(new Uint8Array(await request.audio.arrayBuffer()))
  const attempt = (model: string): Promise<Response> =>
    send(
      fetchFn,
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': request.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: GEMINI_INSTRUCTION },
                { inline_data: { mime_type: baseMimeType(request.mimeType), data } },
              ],
            },
          ],
        }),
      },
      { timeoutMs: TRANSCRIPTION_TRANSFER_TIMEOUT_MS, isStale: request.isStale },
    )

  let response = await attempt(GOOGLE_TRANSCRIPTION_MODEL)
  let body = await response.text()
  // A 404 on the model path means Google retired the model.
  if (response.status === 404) {
    response = await attempt(GOOGLE_TRANSCRIPTION_FALLBACK_MODEL)
    body = await response.text()
  }
  if (!response.ok) {
    throw httpError('google', response.status, body)
  }

  const parsed = geminiResponseSchema.safeParse(safeJson(body))
  if (!parsed.success) {
    throw new ReflectError('parse', `unrecognized gemini response: ${body.slice(0, 200)}`)
  }
  const candidate = parsed.data.candidates?.[0]
  const finishReason = candidate?.finishReason
  if (finishReason !== undefined && finishReason !== 'STOP') {
    // A non-STOP finish (MAX_TOKENS, SAFETY) is deterministic for these
    // bytes — retrying replays the same finish and re-bills the segment on
    // every pass. Settle it as this segment's failure line; the audio stays
    // on disk and the rest of the session is unaffected.
    throw new TranscriptionRejectedError(
      `gemini stopped early (${finishReason}): the transcript would be incomplete`,
    )
  }
  const parts = candidate?.content?.parts ?? []
  return parts.map((part) => part.text ?? '').join('').trim()
}
