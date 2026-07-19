import { z } from 'zod'
import { ReflectError } from '../errors'
import type { TranscriptionProvider } from './provider-config'

/**
 * The HTTP substrate under audio transcription: one guarded `send`, one
 * error ladder, one rejection type. Both provider legs (`ai/transcribe`) and
 * the Gemini Files API protocol (`ai/gemini-files`) issue every request
 * through {@link send}, which is where two cross-cutting contracts live:
 *
 * - **The stale gate.** A transcription can be a multi-request flow; a graph
 *   switch mid-flow must not bill another provider call. `send` checks the
 *   gate before issuing anything, so no call site can forget it.
 * - **Settled timeouts.** Every request carries an abort signal — the UI
 *   must always settle into success or a retryable error, never hang
 *   transcribing against a connection that accepted and then stalled.
 *
 * The error ladder ({@link httpError}) sorts provider failures into the three
 * fates callers act on: `auth` (fix the key), retryable `network` (wait and
 * retry), and {@link TranscriptionRejectedError} (tombstone — the bytes
 * themselves were refused, so retrying cannot help).
 */

/**
 * Control-plane budget: upload session starts, file-state polls, deletes.
 * Payload-bearing calls get {@link TRANSCRIPTION_TRANSFER_TIMEOUT_MS}.
 */
export const TRANSCRIPTION_TIMEOUT_MS = 120_000

/**
 * Budget for calls that carry audio bytes (multipart uploads, inline
 * requests, Files API chunks) — sized for tens of megabytes on a slow
 * uplink, where the control-plane budget would abort a healthy transfer.
 */
export const TRANSCRIPTION_TRANSFER_TIMEOUT_MS = 5 * 60_000

export interface SendOptions {
  /** Overrides {@link TRANSCRIPTION_TIMEOUT_MS} for this call. */
  timeoutMs?: number
  /** The flow's abort gate — checked before the request is issued. */
  isStale?: (() => boolean) | undefined
}

/**
 * Issue one provider request under the stale gate and a settled timeout.
 * Transport failures (thrown fetch, timeout, fired gate) become retryable
 * `network` errors; HTTP-level failures are the caller's to classify via
 * {@link httpError}, because only the caller knows which model/attempt the
 * response belongs to.
 */
export async function send(
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
export function isRecordingRejection(status: number): boolean {
  return status >= 400 && status < 500 && ![401, 403, 404, 408, 429].includes(status)
}

/** Classify a non-OK provider response into the three fates callers act on. */
export function httpError(
  provider: TranscriptionProvider,
  status: number,
  body: string,
): ReflectError {
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

/** The provider's own error message when the body carries one, else the raw body. */
export function providerErrorMessage(body: string): string {
  const parsed = z
    .object({ error: z.object({ message: z.string() }) })
    .safeParse(safeJson(body))
  return parsed.success ? parsed.data.error.message : body.slice(0, 200)
}

/** `JSON.parse` that answers `null` instead of throwing — for probing bodies. */
export function safeJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}
