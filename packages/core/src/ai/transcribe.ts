import { z } from 'zod'
import { ReflectError } from '../errors'
import type { TranscriptionProvider } from './provider-config'

/**
 * BYOK audio transcription (audio memos): one recording in, plain text out.
 * OpenAI is served by its dedicated transcription endpoint, Gemini by a
 * `generateContent` call — inline audio for small recordings, the Files API
 * for meeting-length ones (see {@link GEMINI_INLINE_MAX_BYTES}). Both run on
 * fixed transcription models — the configured entry only picks the provider
 * and key (see `pickTranscriptionConfig`); chat-model choices don't transfer
 * because chat models can't take this endpoint (OpenAI) or would bill
 * pro-tier rates for speech-to-text (Gemini).
 *
 * The recording is **never split client-side**: it's a compressed container
 * (fMP4/WebM), and a byte-slice from its middle has no header, so providers
 * can't decode it. Size policy instead lives in provider byte budgets — the
 * caller routes a recording to a provider whose {@link transcriptionByteLimit}
 * it fits (see `reconcileAudioMemos`), and Gemini's Files API carries what
 * inline requests can't.
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

/**
 * OpenAI's documented per-request ceiling for the transcription endpoint
 * (25 MB). There is no large-file mechanism behind it, so this is also
 * OpenAI's total budget per recording.
 */
export const OPENAI_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024

/**
 * Raw-audio budget for a Gemini *inline* request: the whole JSON body must
 * stay under Gemini's 20 MB request cap, and inline audio rides it
 * base64-encoded (~1.33×). Recordings over this go through the Files API.
 */
export const GEMINI_INLINE_MAX_BYTES = 12 * 1024 * 1024

/** The Files API per-file ceiling (2 GB) — Gemini's total budget per recording. */
export const GEMINI_FILE_MAX_BYTES = 2 * 1024 * 1024 * 1024

/**
 * The largest recording `provider` can transcribe at all. The reconcile pass
 * uses this to route a memo to a capable provider (or leave it pending)
 * *before* reading and uploading it.
 */
export function transcriptionByteLimit(provider: TranscriptionProvider): number {
  return provider === 'openai' ? OPENAI_TRANSCRIPTION_MAX_BYTES : GEMINI_FILE_MAX_BYTES
}

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
 * This is the control-plane budget (upload session start, state polls,
 * deletes); payload-bearing calls get {@link TRANSCRIPTION_TRANSFER_TIMEOUT_MS}.
 */
export const TRANSCRIPTION_TIMEOUT_MS = 120_000

/**
 * Budget for calls that carry audio bytes (multipart uploads, inline
 * requests, Files API chunks) — sized for tens of megabytes on a slow uplink,
 * where the control-plane budget would abort a healthy transfer.
 */
export const TRANSCRIPTION_TRANSFER_TIMEOUT_MS = 5 * 60_000

/**
 * Budget for a `generateContent` call over an uploaded file: the model
 * listens to hours of audio and streams nothing back until done.
 */
export const GEMINI_FILE_TRANSCRIBE_TIMEOUT_MS = 10 * 60_000

interface SendOptions {
  timeoutMs?: number
  /** {@link TranscriptionRequest.isStale} — checked before the call is issued. */
  isStale?: (() => boolean) | undefined
}

async function send(
  fetchFn: typeof fetch,
  input: string,
  init: RequestInit,
  options: SendOptions = {},
): Promise<Response> {
  if (options.isStale?.() === true) {
    throw new ReflectError('network', 'the graph session ended mid-transcription')
  }
  const timeoutMs = options.timeoutMs ?? TRANSCRIPTION_TIMEOUT_MS
  try {
    return await fetchFn(input, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (cause) {
    if (
      cause instanceof DOMException &&
      (cause.name === 'TimeoutError' || cause.name === 'AbortError')
    ) {
      throw new ReflectError(
        'network',
        `transcription request timed out after ${timeoutMs / 1000}s`,
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
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

const GEMINI_INSTRUCTION =
  'Transcribe this audio recording verbatim. Return only the transcribed text, with no commentary or formatting.'

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com'

async function transcribeWithGemini(request: TranscriptionRequest): Promise<string> {
  const audioPart =
    request.audio.size <= GEMINI_INLINE_MAX_BYTES
      ? {
          inline_data: {
            mime_type: baseMimeType(request.mimeType),
            data: bytesToBase64(new Uint8Array(await request.audio.arrayBuffer())),
          },
        }
      : { file_data: await uploadToGeminiFiles(request) }
  try {
    return await geminiGenerateTranscript(request, audioPart)
  } finally {
    if ('file_data' in audioPart) {
      await deleteGeminiFile(request, audioPart.file_data.file_name)
    }
  }
}

type GeminiAudioPart =
  | { inline_data: { mime_type: string; data: string } }
  | { file_data: GeminiUploadedFile }

/** `generateContent` over inline audio or an uploaded file, with model fallback. */
async function geminiGenerateTranscript(
  request: TranscriptionRequest,
  audioPart: GeminiAudioPart,
): Promise<string> {
  const fetchFn = request.fetchFn ?? fetch
  const timeoutMs =
    'file_data' in audioPart ? GEMINI_FILE_TRANSCRIBE_TIMEOUT_MS : TRANSCRIPTION_TRANSFER_TIMEOUT_MS
  const part =
    'file_data' in audioPart
      ? {
          file_data: {
            mime_type: audioPart.file_data.mime_type,
            file_uri: audioPart.file_data.file_uri,
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
          contents: [{ parts: [{ text: GEMINI_INSTRUCTION }, part] }],
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

/** Files API upload chunk size — a multiple of 256 KiB, as the protocol requires. */
const GEMINI_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024

/** Poll cadence and budget while an uploaded recording is `PROCESSING`. */
const GEMINI_FILE_POLL_INTERVAL_MS = 2_000
const GEMINI_FILE_MAX_POLLS = 90

interface GeminiUploadedFile {
  /** Resource name (`files/<id>`) — addresses state polls and the delete. */
  file_name: string
  file_uri: string
  mime_type: string
}

const geminiFileResourceSchema = z.object({
  name: z.string(),
  uri: z.string(),
  // The API always sends `state` in practice; treat an absent one as ready
  // and let `generateContent` be the loud failure if it wasn't.
  state: z.string().optional(),
})

const geminiFinalizeSchema = z.object({ file: geminiFileResourceSchema })

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Push a meeting-length recording through the Files API resumable-upload
 * protocol: open a session, stream the bytes in {@link GEMINI_UPLOAD_CHUNK_BYTES}
 * chunks, then poll until the file is `ACTIVE`. Files live under the user's
 * own key and self-expire after 48 hours; we still delete promptly after
 * transcribing (see `deleteGeminiFile`).
 */
async function uploadToGeminiFiles(request: TranscriptionRequest): Promise<GeminiUploadedFile> {
  const fetchFn = request.fetchFn ?? fetch
  const mimeType = baseMimeType(request.mimeType)
  const sendOptions = { isStale: request.isStale }

  const start = await send(
    fetchFn,
    `${GEMINI_BASE_URL}/upload/v1beta/files`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': request.apiKey,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(request.audio.size),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: 'reflect-audio-memo' } }),
    },
    sendOptions,
  )
  if (!start.ok) {
    throw httpError('google', start.status, await start.text())
  }
  const uploadUrl = start.headers.get('x-goog-upload-url')
  if (uploadUrl === null) {
    throw new ReflectError('network', 'gemini upload session came back without an upload URL')
  }

  let finalBody = ''
  for (let offset = 0; offset < request.audio.size; offset += GEMINI_UPLOAD_CHUNK_BYTES) {
    const chunk = request.audio.slice(offset, offset + GEMINI_UPLOAD_CHUNK_BYTES)
    const isLast = offset + chunk.size >= request.audio.size
    const response = await send(
      fetchFn,
      uploadUrl,
      {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Offset': String(offset),
          'X-Goog-Upload-Command': isLast ? 'upload, finalize' : 'upload',
        },
        body: chunk,
      },
      { timeoutMs: TRANSCRIPTION_TRANSFER_TIMEOUT_MS, isStale: request.isStale },
    )
    const body = await response.text()
    if (!response.ok) {
      throw httpError('google', response.status, body)
    }
    if (isLast) {
      finalBody = body
    }
  }

  const finalized = geminiFinalizeSchema.safeParse(safeJson(finalBody))
  if (!finalized.success) {
    throw new ReflectError(
      'parse',
      `unrecognized gemini upload response: ${finalBody.slice(0, 200)}`,
    )
  }

  let { name, uri, state } = finalized.data.file
  for (let polls = 0; state !== undefined && state !== 'ACTIVE'; polls += 1) {
    if (state === 'FAILED') {
      // Gemini decoded the upload and gave up on the bytes themselves — the
      // same recording would fail again, so this must tombstone, not retry.
      throw new TranscriptionRejectedError('google could not process the uploaded recording')
    }
    if (polls >= GEMINI_FILE_MAX_POLLS) {
      throw new ReflectError('network', 'timed out waiting for the uploaded recording to process')
    }
    if (polls > 0) {
      await sleep(GEMINI_FILE_POLL_INTERVAL_MS)
    }
    const response = await send(
      fetchFn,
      `${GEMINI_BASE_URL}/v1beta/${name}`,
      { headers: { 'x-goog-api-key': request.apiKey } },
      sendOptions,
    )
    const body = await response.text()
    if (!response.ok) {
      throw httpError('google', response.status, body)
    }
    const resource = geminiFileResourceSchema.safeParse(safeJson(body))
    if (!resource.success) {
      throw new ReflectError('parse', `unrecognized gemini file state: ${body.slice(0, 200)}`)
    }
    ;({ name, uri, state } = resource.data)
  }

  return { file_name: name, file_uri: uri, mime_type: mimeType }
}

/**
 * Best-effort cleanup of an uploaded recording — the transcript is local now,
 * so the copy on Google's side has no reason to live out its 48-hour TTL.
 * Skipped after a stale gate fired (no more calls once the session ended);
 * failures are ignored because expiry cleans up regardless.
 */
async function deleteGeminiFile(request: TranscriptionRequest, fileName: string): Promise<void> {
  if (request.isStale?.() === true) {
    return
  }
  const fetchFn = request.fetchFn ?? fetch
  await send(fetchFn, `${GEMINI_BASE_URL}/v1beta/${fileName}`, {
    method: 'DELETE',
    headers: { 'x-goog-api-key': request.apiKey },
  }).catch(() => {})
}
