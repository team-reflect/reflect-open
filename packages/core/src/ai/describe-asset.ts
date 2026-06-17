import { APICallError, generateText, type UserContent } from 'ai'
import { ReflectError } from '../errors'
import type { AiProviderConfig } from '../settings/schema'
import { languageModel } from './language-model'

/**
 * BYOK description + OCR for one asset (Plan 20): a single short multimodal
 * call over an image or PDF that returns Markdown — a concise description
 * plus any text the asset contains. The sibling of `describe-page` (link
 * capture); same provider wiring and the same error contract. Privacy is the
 * caller's responsibility and is gated long before this module is reached.
 */

const DESCRIBE_TIMEOUT_MS = 60_000

/** SVG is sent as source text, not an image part; cap the prompt's excerpt. */
const MAX_SVG_CHARS = 32_000

/** What the asset is, which decides how it enters the provider request. */
export type AssetKind = 'image' | 'pdf' | 'svg'

export interface DescribeAssetRequest {
  /** The provider entry to call (the app default). */
  config: AiProviderConfig
  /** The BYOK API key, read from the OS keychain by the caller. */
  apiKey: string
  /** Host transport (the Tauri HTTP plugin's fetch; tests pass a stub). */
  fetchFn?: typeof fetch | undefined
  /** How `data` is carried: image input, file input, or SVG source text. */
  kind: AssetKind
  /** IANA media type (e.g. `image/png`, `application/pdf`, `image/svg+xml`). */
  mediaType: string
  /**
   * The payload. base64 (no data-URL prefix) for `image`/`pdf`; the raw UTF-8
   * source for `svg` (vision endpoints reject `image/svg+xml`, but the markup
   * itself describes the graphic).
   */
  data: string
  /** The asset's filename, used only to ground the prompt. */
  filename: string
}

/**
 * The provider refused this asset itself (unsupported type, payload too large,
 * a model with no vision/file support…). Retrying the same payload can't help,
 * so the caller logs it and writes no description file — never a failure one.
 */
export class AssetDescriptionRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssetDescriptionRejectedError'
  }
}

/** Type guard for the provider-refusal path. */
export function isAssetDescriptionRejected(value: unknown): value is AssetDescriptionRejectedError {
  return value instanceof AssetDescriptionRejectedError
}

function classify(cause: unknown): Error {
  if (APICallError.isInstance(cause)) {
    const status = cause.statusCode ?? 0
    if (status === 401 || status === 403) {
      return new ReflectError('auth', `the provider rejected the API key (${status})`)
    }
    if (status === 429 || status >= 500) {
      return new ReflectError('network', `the provider is unavailable (${status})`)
    }
    if (status >= 400) {
      return new AssetDescriptionRejectedError(cause.message)
    }
  }
  if (cause instanceof DOMException && cause.name === 'TimeoutError') {
    return new ReflectError('network', 'the description request timed out')
  }
  return cause instanceof Error ? cause : new Error(String(cause))
}

function subject(kind: AssetKind): string {
  switch (kind) {
    case 'pdf':
      return 'PDF document'
    case 'svg':
      return 'SVG image'
    case 'image':
      return 'image'
  }
}

function describePrompt(kind: AssetKind, filename: string): string {
  return [
    `Describe this ${subject(kind)} ("${filename}") so its contents are searchable.`,
    'Write Markdown:',
    '- Start with one or two plain sentences describing what it shows.',
    '- If it contains readable text, add a "## Text" section transcribing that text (OCR), preserving meaningful structure such as headings, lists, and tables.',
    'Answer with the Markdown only — no preamble, and do not wrap the whole answer in a code fence.',
  ].join('\n')
}

/**
 * Generate the description Markdown for one asset. Throws {@link ReflectError}
 * (`auth`, `network`) for transient/credential failures the caller should
 * retry later, and {@link AssetDescriptionRejectedError} when the provider
 * refuses this asset itself. The enrichment pass is the retry layer
 * (`maxRetries: 0`).
 */
export async function describeAsset(request: DescribeAssetRequest): Promise<string> {
  const content: UserContent = [{ type: 'text', text: describePrompt(request.kind, request.filename) }]
  if (request.kind === 'image') {
    content.push({ type: 'image', image: request.data, mediaType: request.mediaType })
  } else if (request.kind === 'pdf') {
    content.push({
      type: 'file',
      data: request.data,
      mediaType: request.mediaType,
      filename: request.filename,
    })
  } else {
    content.push({ type: 'text', text: `SVG source:\n${request.data.slice(0, MAX_SVG_CHARS)}` })
  }
  try {
    const result = await generateText({
      model: languageModel(request.config, request.apiKey, request.fetchFn ?? fetch),
      messages: [{ role: 'user', content }],
      abortSignal: AbortSignal.timeout(DESCRIBE_TIMEOUT_MS),
      maxRetries: 0,
    })
    return result.text.trim()
  } catch (cause) {
    throw classify(cause)
  }
}
