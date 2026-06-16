import { z } from 'zod'
import { ReflectError } from '../errors'
import type { TranscriptionProvider } from './provider-config'

/**
 * BYOK audio transcription (audio memos): one short recording in, plain text
 * out. OpenAI is served by its dedicated transcription endpoint, Gemini by a
 * `generateContent` call with inline audio. Both run on fixed transcription
 * models — the configured entry only picks the provider and key (see
 * `pickTranscriptionConfig`); chat-model choices don't transfer because chat
 * models can't take this endpoint (OpenAI) or would bill pro-tier rates for
 * speech-to-text (Gemini).
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

/** The provider's own error message when the body carries one, else the raw body. */
function providerErrorMessage(body: string): string {
  const parsed = z
    .object({ error: z.object({ message: z.string() }) })
    .safeParse(safeJson(body))
  return parsed.success ? parsed.data.error.message : body.slice(0, 200)
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

/**
 * The provider refused this specific recording (unsupported container,
 * oversized payload): the same bytes would be refused again, so callers must
 * tombstone the recording rather than retry — treating this as a transient
 * failure would wedge a retry queue forever. Connectivity failures, rate
 * limits, and retired-model 404s stay plain `network` errors; those heal on
 * a later attempt.
 */
export class TranscriptionRejectedError extends ReflectError {
  constructor(message: string) {
    super('parse', message)
    this.name = 'TranscriptionRejectedError'
  }
}

/** Type guard for {@link TranscriptionRejectedError}. */
export function isTranscriptionRejected(value: unknown): value is TranscriptionRejectedError {
  return value instanceof TranscriptionRejectedError
}

/**
 * A 4xx that condemns the recording itself — never auth (401/403), a
 * missing model/endpoint (404), a timeout (408), or a rate limit (429),
 * all of which a later attempt can survive.
 */
function isRecordingRejection(status: number): boolean {
  return status >= 400 && status < 500 && ![401, 403, 404, 408, 429].includes(status)
}

function httpError(provider: TranscriptionProvider, status: number, body: string): ReflectError {
  if (status === 401 || status === 403) {
    return new ReflectError('auth', `${provider} rejected the API key (${status})`)
  }
  if (isRecordingRejection(status)) {
    return new TranscriptionRejectedError(
      `${provider} rejected the recording (${status}): ${providerErrorMessage(body)}`,
    )
  }
  return new ReflectError(
    'network',
    `${provider} transcription failed (${status}): ${providerErrorMessage(body)}`,
  )
}

/**
 * Bounds a provider connection that accepts and then stalls — the UI must
 * always settle into success or a retryable error, never hang transcribing.
 */
export const TRANSCRIPTION_TIMEOUT_MS = 120_000

async function send(
  fetchFn: typeof fetch,
  input: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchFn(input, {
      ...init,
      signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
    })
  } catch (cause) {
    if (
      cause instanceof DOMException &&
      (cause.name === 'TimeoutError' || cause.name === 'AbortError')
    ) {
      throw new ReflectError(
        'network',
        `transcription request timed out after ${TRANSCRIPTION_TIMEOUT_MS / 1000}s`,
      )
    }
    throw new ReflectError('network', cause instanceof Error ? cause.message : String(cause))
  }
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
    return send(fetchFn, 'https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${request.apiKey}` },
      body: form,
    })
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
        content: z
          .object({
            parts: z.array(z.object({ text: z.string().optional() })).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
})

/**
 * Encode in 32 KiB chunks: spreading a whole multi-megabyte recording into
 * one `String.fromCharCode` call overflows the argument limit.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_SIZE))
  }
  return btoa(binary)
}

/** Decode {@link bytesToBase64}'s output (a stored recording read back). */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

const GEMINI_INSTRUCTION =
  'Transcribe this audio recording verbatim. Return only the transcribed text, with no commentary or formatting.'

async function transcribeWithGemini(request: TranscriptionRequest): Promise<string> {
  const fetchFn = request.fetchFn ?? fetch
  const data = bytesToBase64(new Uint8Array(await request.audio.arrayBuffer()))
  const attempt = (model: string): Promise<Response> =>
    send(fetchFn, `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
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
    })

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
  const parts = parsed.data.candidates?.[0]?.content?.parts ?? []
  return parts.map((part) => part.text ?? '').join('').trim()
}
