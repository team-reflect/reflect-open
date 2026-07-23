import { z } from 'zod'
import { ReflectError } from '../errors'
import { blobChunks } from '../lib/blob'
import { baseMimeType } from './audio-mime'
import {
  send,
  httpError,
  safeJson,
  TranscriptionRejectedError,
  TRANSCRIPTION_TRANSFER_TIMEOUT_MS,
  type SendOptions,
} from './transcribe-http'

/**
 * The Gemini Files API resumable-upload protocol, as transcription uses it.
 *
 * Gemini caps a `generateContent` request at ~20 MB, so meeting-length
 * recordings can't ride inline base64. The Files API is Google's answer: a
 * three-step flow — open an upload session, stream the bytes in chunks,
 * reference the finished file by URI — that takes files up to 2 GB. Files
 * live under the *user's own key* (BYOK: this is their Google account, not
 * any Reflect infrastructure) and self-expire after 48 hours; we still
 * delete promptly once the transcript is local (see {@link deleteGeminiFile}).
 *
 * Protocol sketch (headers are the API's own, verbatim):
 *
 * 1. `POST /upload/v1beta/files` with `X-Goog-Upload-Protocol: resumable`
 *    and `X-Goog-Upload-Command: start` → the upload URL arrives in the
 *    `x-goog-upload-url` response header.
 * 2. `POST <upload url>` per chunk with `X-Goog-Upload-Offset` and
 *    `X-Goog-Upload-Command: upload` (`upload, finalize` on the last) —
 *    chunk sizes must be multiples of 256 KiB.
 * 3. Poll `GET /v1beta/<file name>` until the file leaves `PROCESSING`:
 *    `ACTIVE` is ready for `generateContent`; `FAILED` means Google decoded
 *    the upload and gave up on the bytes themselves — a tombstone, not a
 *    retry.
 *
 * Every request goes through `send`, so the stale gate and settled timeouts
 * apply to each step of the flow, not just its start.
 */

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com'

/**
 * Budget for a `generateContent` call over an uploaded file: the model
 * listens to hours of audio and streams nothing back until done.
 */
export const GEMINI_FILE_TRANSCRIBE_TIMEOUT_MS = 10 * 60_000

/** Upload chunk size — a multiple of 256 KiB, as the protocol requires. */
const GEMINI_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024

/**
 * Poll cadence and budget while an uploaded recording is `PROCESSING` —
 * sized for the biggest real upload (a 4-hour memo, ~200 MB), which can take
 * Google minutes to decode. Running out is a retryable `network` error, but
 * the retry re-uploads from scratch, so the budget errs generous.
 */
const GEMINI_FILE_POLL_INTERVAL_MS = 2_000
const GEMINI_FILE_MAX_POLLS = 150

/** What {@link uploadToGeminiFiles} needs from a transcription request. */
export interface GeminiFileUploadRequest {
  apiKey: string
  /** The recording, uploaded as-is (no client-side re-encoding). */
  audio: Blob
  /** The recording's MIME type, possibly with codec parameters. */
  mimeType: string
  /** Host transport; defaults to global `fetch`. */
  fetchFn?: typeof fetch | undefined
  /** Abort gate, honored before every request in the flow. */
  isStale?: (() => boolean) | undefined
}

/** An uploaded, `ACTIVE` file, ready to reference from `generateContent`. */
export interface GeminiUploadedFile {
  /** Resource name (`files/<id>`) — addresses state polls and the delete. */
  fileName: string
  /** The URI `generateContent` cites in its `file_data` part. */
  fileUri: string
  /** Parameter-free MIME type the file was uploaded under. */
  mimeType: string
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
 * Push a meeting-length recording through the resumable-upload flow and wait
 * until it is ready to transcribe. Throws the shared transcription error
 * ladder: retryable `network` for transport/session problems,
 * {@link TranscriptionRejectedError} when Google marks the file `FAILED`
 * (the same bytes would fail again).
 */
export async function uploadToGeminiFiles(
  request: GeminiFileUploadRequest,
): Promise<GeminiUploadedFile> {
  const fetchFn = request.fetchFn ?? fetch
  const mimeType = baseMimeType(request.mimeType)
  const sendOptions: SendOptions = { isStale: request.isStale }

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
  let offset = 0
  for (const chunk of blobChunks(request.audio, GEMINI_UPLOAD_CHUNK_BYTES)) {
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
    offset += chunk.size
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
      // Google decoded the upload and gave up on the bytes themselves — the
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

  return { fileName: name, fileUri: uri, mimeType }
}

/**
 * Best-effort cleanup of an uploaded recording — the transcript is local
 * now, so the copy on Google's side has no reason to live out its 48-hour
 * TTL. Skipped after a stale gate fired (no more calls once the session
 * ended); failures are ignored because expiry cleans up regardless.
 */
export async function deleteGeminiFile(
  request: GeminiFileUploadRequest,
  fileName: string,
): Promise<void> {
  if (request.isStale?.() === true) {
    return
  }
  const fetchFn = request.fetchFn ?? fetch
  await send(fetchFn, `${GEMINI_BASE_URL}/v1beta/${fileName}`, {
    method: 'DELETE',
    headers: { 'x-goog-api-key': request.apiKey },
  }).catch(() => {})
}
