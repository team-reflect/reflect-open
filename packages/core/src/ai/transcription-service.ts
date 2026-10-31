import { z } from 'zod'
import type { HttpService } from '../ports/http-service.ts'
import { bytesToBase64, safeParseJson } from '@reflect/utils'
import { AppError } from '../errors.ts'
import { APP_REVIEW_STUB_KEY, stubTranscriptBody } from './app-review-demo.ts'
import type { TranscriptionProvider } from './provider-config.ts'
import {
  httpError,
  send,
  TranscriptionOversizeError,
  TranscriptionRejectedError,
  TRANSCRIPTION_TRANSFER_TIMEOUT_MS,
} from './transcribe-http.ts'

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

export const OPENAI_TRANSCRIPTION_MODEL = 'gpt-transcribe'

/**
 * Retried in order while the model is missing on the key — project-scoped
 * OpenAI keys may expose only the models this app used before
 * `gpt-transcribe`, and some expose `whisper-1` but not the 4o transcription
 * models. Both shut down on 2027-02-26.
 */
export const OPENAI_TRANSCRIPTION_FALLBACK_MODELS = ['gpt-4o-mini-transcribe', 'whisper-1'] as const

export const GOOGLE_TRANSCRIPTION_MODEL = 'gemini-3.6-flash'

/**
 * Retried once when the primary model 404s. Google retires models on a short
 * clock (the spike caught `gemini-3-pro-preview` dying within months of
 * release), and a retired transcription model must degrade, not hard-fail.
 * An alias rather than a pinned id, so the fallback itself never retires.
 */
export const GOOGLE_TRANSCRIPTION_FALLBACK_MODEL = 'gemini-flash-latest'

export interface TranscriptionRequest {
  provider: TranscriptionProvider
  apiKey: string
  /**
   * The recording, as MediaRecorder produced it.
   */
  audio: Blob
  /**
   * The recording's MIME type, possibly with codec parameters.
   */
  mimeType: string
  /**
   * User transcription hint, if any.
   */
  prompt?: string | undefined
  /**
   * Abort gate consulted before every provider call — a graph switch
   * mid-pass must not bill another call. Firing reads as a retryable
   * `network` error.
   */
  isStale?: (() => boolean) | undefined
}

export interface TranscriptionServiceDeps {
  readonly http: HttpService
}

/**
 * Speech to text for one recording.
 */
export interface TranscriptionService {
  /**
   * Transcribe one recording, returning the trimmed transcript (empty when the
   * provider heard nothing). Throws {@link AppError}: `auth` when the key is
   * rejected, `network` when the call can't complete, `parse` when the response
   * shape is unrecognizable.
   */
  transcribe(request: TranscriptionRequest): Promise<string>
  /**
   * The transcript this service gives a whole recording session for `apiKey`
   * without reading any audio, or `null` when the session's segments must be
   * transcribed. Only the App Review demo key gets one: a canned transcript
   * without any provider call.
   */
  sessionTranscript(apiKey: string): string | null
}

class TranscriptionServiceImpl implements TranscriptionService {
  readonly #fetch: typeof fetch

  constructor(deps: TranscriptionServiceDeps) {
    this.#fetch = (input, init) => deps.http.fetch(input, init)
  }

  async transcribe(request: TranscriptionRequest): Promise<string> {
    return (
      this.#demoTranscript(request.apiKey) ??
      (request.provider === 'openai'
        ? await transcribeWithOpenAi(this.#fetch, request)
        : await transcribeWithGemini(this.#fetch, request))
    )
  }

  sessionTranscript(apiKey: string): string | null {
    return this.#demoTranscript(apiKey)
  }

  #demoTranscript(apiKey: string): string | null {
    return apiKey === APP_REVIEW_STUB_KEY ? stubTranscriptBody() : null
  }
}

export function createTranscriptionService(deps: TranscriptionServiceDeps): TranscriptionService {
  return new TranscriptionServiceImpl(deps)
}

/**
 * `audio/webm;codecs=opus` → `audio/webm` — parameters confuse provider sniffing.
 */
export function baseMimeType(mimeType: string): string {
  return (mimeType.split(';')[0] ?? mimeType).trim().toLowerCase()
}

/**
 * File extension per audio MIME type — shared by the provider upload filename
 * and the on-disk naming of saved memos (`audio/audio-memo`), which must
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
    .safeParse(safeParseJson(body))
  return parsed.success && parsed.data.error.code === 'model_not_found'
}

interface ModelReply {
  readonly response: Response
  readonly body: string
}

/**
 * Send to each model in turn, moving on only while `isMissing` says the model
 * is not available on the key. The last model's reply is final.
 */
async function attemptInOrder(
  models: readonly [string, ...string[]],
  attempt: (model: string) => Promise<Response>,
  isMissing: (reply: ModelReply) => boolean,
): Promise<ModelReply> {
  const [model, ...fallbacks] = models
  const response = await attempt(model)
  const reply = { response, body: await response.text() }
  const [next, ...rest] = fallbacks
  if (next !== undefined && isMissing(reply)) {
    return await attemptInOrder([next, ...rest], attempt, isMissing)
  }
  return reply
}

async function transcribeWithOpenAi(
  fetchFn: typeof fetch,
  request: TranscriptionRequest,
): Promise<string> {
  const attempt = (model: string): Promise<Response> => {
    const form = new FormData()
    form.append('file', request.audio, uploadFilename(request.mimeType))
    form.append('model', model)
    if (request.prompt) {
      form.append('prompt', request.prompt)
    }
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

  const { response, body } = await attemptInOrder(
    [OPENAI_TRANSCRIPTION_MODEL, ...OPENAI_TRANSCRIPTION_FALLBACK_MODELS],
    attempt,
    (reply) => !reply.response.ok && isModelNotFound(reply.body),
  )
  if (!response.ok) {
    throw httpError('openai', response.status, body)
  }

  const parsed = openAiResponseSchema.safeParse(safeParseJson(body))
  if (!parsed.success) {
    throw new AppError('parse', `unrecognized openai transcription response: ${body.slice(0, 200)}`)
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

async function transcribeWithGemini(
  fetchFn: typeof fetch,
  request: TranscriptionRequest,
): Promise<string> {
  if (request.audio.size > GEMINI_INLINE_MAX_BYTES) {
    throw new TranscriptionOversizeError(
      `the recording does not fit a gemini inline request (${request.audio.size} bytes)`,
    )
  }
  const data = bytesToBase64(new Uint8Array(await request.audio.arrayBuffer()))
  const instruction = request.prompt
    ? `${GEMINI_INSTRUCTION}\n${request.prompt}`
    : GEMINI_INSTRUCTION
  const attempt = (model: string): Promise<Response> => {
    return send(
      fetchFn,
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': request.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: instruction },
                { inline_data: { mime_type: baseMimeType(request.mimeType), data } },
              ],
            },
          ],
        }),
      },
      { timeoutMs: TRANSCRIPTION_TRANSFER_TIMEOUT_MS, isStale: request.isStale },
    )
  }

  const { response, body } = await attemptInOrder(
    [GOOGLE_TRANSCRIPTION_MODEL, GOOGLE_TRANSCRIPTION_FALLBACK_MODEL],
    attempt,
    // A 404 on the model path means Google retired the model.
    (reply) => reply.response.status === 404,
  )
  if (!response.ok) {
    throw httpError('google', response.status, body)
  }

  const parsed = geminiResponseSchema.safeParse(safeParseJson(body))
  if (!parsed.success) {
    throw new AppError('parse', `unrecognized gemini response: ${body.slice(0, 200)}`)
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
  return parts
    .map((part) => part.text ?? '')
    .join('')
    .trim()
}
