import { z } from 'zod'
import { ReflectError } from '../errors'
import { bytesToBase64 } from '../lib/base64'
import type { TranscriptionProvider } from './provider-config'
import { AUDIO_EXTENSION_BY_MIME, baseMimeType } from './audio-mime'
import {
  deleteGeminiFile,
  uploadToGeminiFiles,
  GEMINI_BASE_URL,
  GEMINI_FILE_TRANSCRIBE_TIMEOUT_MS,
  type GeminiUploadedFile,
} from './gemini-files'
import {
  httpError,
  isRecordingRejection,
  safeJson,
  send,
  TRANSCRIPTION_TRANSFER_TIMEOUT_MS,
} from './transcribe-http'

/**
 * BYOK audio transcription (audio memos): one recording in, plain text out.
 * OpenAI is served by its dedicated transcription endpoint, Gemini by a
 * `generateContent` call — inline audio for small recordings, the Files API
 * for meeting-length ones (see {@link GEMINI_INLINE_MAX_BYTES} and
 * `ai/gemini-files`). Both run on fixed transcription models — the
 * configured entry only picks the provider and key (see
 * `pickTranscriptionConfig`); chat-model choices don't transfer because chat
 * models can't take this endpoint (OpenAI) or would bill pro-tier rates for
 * speech-to-text (Gemini).
 *
 * This module holds only the two provider legs. Which provider a recording
 * *goes to* — the size-based routing that keeps oversized memos away from
 * providers that would refuse them — is `ai/transcription-routing`; the
 * shared HTTP substrate (stale gate, timeouts, error ladder) is
 * `ai/transcribe-http`.
 */

export const OPENAI_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe'

/**
 * Retried when the primary model is missing on the key (project-scoped
 * OpenAI keys can expose `whisper-1` but not the 4o transcription models) —
 * and when the primary *refuses the recording*, because the 4o models cap
 * audio duration well below whisper-1's and a long memo they refuse can
 * still transcribe.
 */
export const OPENAI_TRANSCRIPTION_FALLBACK_MODEL = 'whisper-1'

export const GOOGLE_TRANSCRIPTION_MODEL = 'gemini-3.5-flash'

/**
 * Retried once when the primary model 404s. Google retires models on a short
 * clock (the spike caught `gemini-3-pro-preview` dying within months of
 * release), and a retired transcription model must degrade, not hard-fail.
 */
export const GOOGLE_TRANSCRIPTION_FALLBACK_MODEL = 'gemini-2.5-flash'

/**
 * Raw-audio budget for a Gemini *inline* request: the whole JSON body must
 * stay under Gemini's 20 MB request cap, and inline audio rides it
 * base64-encoded (~1.33×). Recordings over this go through the Files API.
 */
export const GEMINI_INLINE_MAX_BYTES = 12 * 1024 * 1024

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
   * Abort gate consulted before **every** provider call — a Files API
   * transcription is a multi-request flow, and a graph switch mid-flow must
   * not bill another call. Firing reads as a retryable `network` error.
   */
  isStale?: (() => boolean) | undefined
}

/**
 * Transcribe one recording, returning the trimmed transcript (empty when the
 * provider heard nothing). Throws `ReflectError`: `auth` when the key is
 * rejected, `network` when the call can't complete, `parse` when the
 * response shape is unrecognizable — and `TranscriptionRejectedError` (see
 * `ai/transcribe-http`) when the recording itself was refused and must be
 * tombstoned rather than retried.
 */
export async function transcribeAudio(request: TranscriptionRequest): Promise<string> {
  return request.provider === 'openai'
    ? transcribeWithOpenAi(request)
    : transcribeWithGemini(request)
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
  // Fall back on a missing model (project-scoped keys) — and on a recording
  // rejection: the 4o transcription models cap audio *duration* well below
  // whisper-1's, so a long memo the primary refuses can still transcribe.
  // Costs one duplicate upload only when the recording is already doomed.
  if (!response.ok && (isModelNotFound(body) || isRecordingRejection(response.status))) {
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

const GEMINI_INSTRUCTION =
  'Transcribe this audio recording verbatim. Return only the transcribed text, with no commentary or formatting.'

async function transcribeWithGemini(request: TranscriptionRequest): Promise<string> {
  const audioPart =
    request.audio.size <= GEMINI_INLINE_MAX_BYTES
      ? {
          inline_data: {
            mime_type: baseMimeType(request.mimeType),
            data: bytesToBase64(new Uint8Array(await request.audio.arrayBuffer())),
          },
        }
      : { file: await uploadToGeminiFiles(request) }
  try {
    return await geminiGenerateTranscript(request, audioPart)
  } finally {
    if ('file' in audioPart) {
      await deleteGeminiFile(request, audioPart.file.fileName)
    }
  }
}

type GeminiAudioPart =
  | { inline_data: { mime_type: string; data: string } }
  | { file: GeminiUploadedFile }

/** `generateContent` over inline audio or an uploaded file, with model fallback. */
async function geminiGenerateTranscript(
  request: TranscriptionRequest,
  audioPart: GeminiAudioPart,
): Promise<string> {
  const fetchFn = request.fetchFn ?? fetch
  const timeoutMs =
    'file' in audioPart ? GEMINI_FILE_TRANSCRIBE_TIMEOUT_MS : TRANSCRIPTION_TRANSFER_TIMEOUT_MS
  // The wire shape is the API's snake_case; TypeScript stays camelCase up to
  // this boundary (see `GeminiUploadedFile`).
  const wirePart =
    'file' in audioPart
      ? {
          file_data: {
            mime_type: audioPart.file.mimeType,
            file_uri: audioPart.file.fileUri,
          },
        }
      : audioPart
  const attempt = (model: string): Promise<Response> =>
    send(
      fetchFn,
      `${GEMINI_BASE_URL}/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': request.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: GEMINI_INSTRUCTION }, wirePart] }],
        }),
      },
      { timeoutMs, isStale: request.isStale },
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
  const parts = parsed.data.candidates?.[0]?.content?.parts ?? []
  return parts.map((part) => part.text ?? '').join('').trim()
}
