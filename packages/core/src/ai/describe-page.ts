import { APICallError, generateText, type UserContent } from 'ai'
import { ReflectError } from '../errors'
import type { AiProviderConfig } from '../settings/schema'
import { languageModel } from './language-model'

/**
 * BYOK page description for link capture (Plan 11): one short multimodal call
 * — the capture's screenshot plus its scraped context — returning a one-to-two
 * sentence description of the page. Runs on the user's default configured
 * entry (every curated model accepts image input); the caller gates privacy
 * before this module is ever reached.
 */

const DESCRIBE_TIMEOUT_MS = 60_000

/** Caps the prompt's selection excerpt; the model needs gist, not the article. */
const MAX_SELECTION_CHARS = 1_000
const MAX_CONTENT_TEXT_CHARS = 6_000

export interface DescribePageRequest {
  /** The provider entry to call (the app default). */
  config: AiProviderConfig
  /** The BYOK API key, read from the OS keychain by the caller. */
  apiKey: string
  /** Host transport (the Tauri HTTP plugin's fetch; tests pass a stub). */
  fetchFn?: typeof fetch | undefined
  /** The captured page. */
  url: string
  title: string
  /** Text the user had selected, if any. */
  selection?: string | undefined
  /** Extracted full-page text, capped before it enters the provider prompt. */
  contentText?: string | undefined
  /** Scraped meta description, if the scrape produced one. */
  metaDescription?: string | undefined
  /** Downscaled JPEG screenshot, base64 (no data-URL prefix), if captured. */
  screenshotBase64?: string | undefined
}

/**
 * The provider refused this capture itself (an input too large, an unsupported
 * image…) — retrying the same payload can't help, so the caller falls back to
 * the scraped description instead of blocking the queue behind it.
 */
export class DescriptionRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DescriptionRejectedError'
  }
}

/** Type guard for the provider-refusal path. */
export function isDescriptionRejected(value: unknown): value is DescriptionRejectedError {
  return value instanceof DescriptionRejectedError
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
      return new DescriptionRejectedError(cause.message)
    }
  }
  if (cause instanceof DOMException && cause.name === 'TimeoutError') {
    return new ReflectError('network', 'the description request timed out')
  }
  return cause instanceof Error ? cause : new Error(String(cause))
}

function describePrompt(request: DescribePageRequest): string {
  const lines = [
    'Describe this web page in one or two plain sentences for a bookmark note:',
    `URL: ${request.url}`,
  ]
  if (request.title.trim() !== '') {
    lines.push(`Title: ${request.title.trim()}`)
  }
  if (request.metaDescription) {
    lines.push(`Meta description: ${request.metaDescription}`)
  }
  if (request.selection) {
    lines.push(`Text the user highlighted: ${request.selection.slice(0, MAX_SELECTION_CHARS)}`)
  }
  if (request.contentText) {
    lines.push(`Extracted page text: ${request.contentText.slice(0, MAX_CONTENT_TEXT_CHARS)}`)
  }
  lines.push(
    'Base the description on the extracted page text when present, and the screenshot when one is attached.',
    'Answer with the description only — no preamble, no markdown.',
  )
  return lines.join('\n')
}

/**
 * Generate the description. Throws {@link ReflectError} (`auth`, `network`)
 * for transient/credential failures the caller should retry later, and
 * {@link DescriptionRejectedError} when the provider refuses this capture
 * itself.
 */
export async function describePage(request: DescribePageRequest): Promise<string> {
  const content: UserContent = [{ type: 'text', text: describePrompt(request) }]
  if (request.screenshotBase64) {
    content.push({
      type: 'image',
      image: request.screenshotBase64,
      mediaType: 'image/jpeg',
    })
  }
  try {
    const result = await generateText({
      model: languageModel(request.config, request.apiKey, request.fetchFn ?? fetch),
      messages: [{ role: 'user', content }],
      abortSignal: AbortSignal.timeout(DESCRIBE_TIMEOUT_MS),
      // The enrichment pass is the retry layer (next trigger re-runs pending
      // captures); the SDK's own backoff would only delay that.
      maxRetries: 0,
    })
    return result.text.trim()
  } catch (cause) {
    throw classify(cause)
  }
}
