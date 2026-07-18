import { APICallError, generateObject, NoObjectGeneratedError, type UserContent } from 'ai'
import { z } from 'zod'
import { ReflectError } from '../errors'
import { wikiLinkSafe } from '../markdown/edit'
import type { AiProviderConfig } from '../settings/schema'
import { languageModel } from './language-model'
import { clipAtWordBoundary } from './text'

/**
 * BYOK page enrichment for link capture (Plan 11): one short multimodal call
 * — the capture's screenshot plus its scraped context — returning a cleaned-up
 * display title and a one-to-two sentence description of the page. Runs on the
 * user's default configured entry (every curated model accepts image input);
 * the caller gates privacy before this module is ever reached.
 */

const DESCRIBE_TIMEOUT_MS = 60_000

/** Caps the prompt's selection excerpt; the model needs gist, not the article. */
const MAX_SELECTION_CHARS = 1_000
const MAX_CONTENT_TEXT_CHARS = 6_000

/** Caps the returned title — it renders as an H1 and a wiki-link display text. */
const MAX_TITLE_CHARS = 100

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
  /** Scraped `og:title`, when the scrape produced one. */
  metaTitle?: string | undefined
  /** Scraped `og:site_name` — lets the model strip site suffixes from the title. */
  siteName?: string | undefined
  /** Text the user had selected, if any. */
  selection?: string | undefined
  /** Extracted full-page text, capped before it enters the provider prompt. */
  contentText?: string | undefined
  /** Scraped meta description, if the scrape produced one. */
  metaDescription?: string | undefined
  /** Downscaled JPEG screenshot, base64 (no data-URL prefix), if captured. */
  screenshotBase64?: string | undefined
}

/** What one enrichment call produces for a captured page. */
export interface PageEnrichment {
  /**
   * The cleaned-up display title, wiki-link safe and capped, or `null` when
   * the model produced nothing usable — the caller keeps the captured title.
   */
  title: string | null
  /** One-to-two plain sentences describing the page. */
  description: string
}

const pageDescriptionSchema = z.object({
  title: z.string(),
  description: z.string(),
})

/**
 * The provider refused this capture itself (an input too large, an unsupported
 * image, an answer that never parsed…) — retrying the same payload can't help,
 * so the caller falls back to the scraped description instead of blocking the
 * queue behind it.
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
  if (NoObjectGeneratedError.isInstance(cause)) {
    return new DescriptionRejectedError(cause.message)
  }
  if (cause instanceof DOMException && cause.name === 'TimeoutError') {
    return new ReflectError('network', 'the description request timed out')
  }
  return cause instanceof Error ? cause : new Error(String(cause))
}

function describePrompt(request: DescribePageRequest): string {
  const lines = [
    'Enrich this web page capture for a bookmark note:',
    `URL: ${request.url}`,
  ]
  if (request.title.trim() !== '') {
    lines.push(`Captured title: ${request.title.trim()}`)
  }
  if (request.metaTitle) {
    lines.push(`Meta title: ${request.metaTitle}`)
  }
  if (request.siteName) {
    lines.push(`Site name: ${request.siteName}`)
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
    'Ground both fields in the extracted page text when present, and the screenshot when one is attached.',
    "title: the page's own title cleaned up for display — drop the site name, separators, and SEO clutter; keep the page's language and its plain wording. The captured title may not describe the page at all: share sheets often supply boilerplate (\"See this Instagram post by @user\"), a bare domain, or message text — in that case build the title from the meta title, page text, or screenshot instead of keeping it. Never invent an editorial retitle; when the captured title already describes the page cleanly, return it unchanged.",
    'description: one or two plain sentences describing the page — no preamble, no markdown.',
  )
  return lines.join('\n')
}

/**
 * Sanitize a candidate display title — from the model or from scraped meta
 * tags — for use as a capture note's H1 and wiki-link display text: wiki-link
 * safe and clipped at a word boundary, or `null` when nothing displayable
 * survives (the caller keeps the current title).
 */
export function normalizedPageTitle(candidate: string): string | null {
  const safe = clipAtWordBoundary(wikiLinkSafe(candidate), MAX_TITLE_CHARS)
  return safe === '' ? null : safe
}

/**
 * Generate the title and description. Throws {@link ReflectError} (`auth`,
 * `network`) for transient/credential failures the caller should retry later,
 * and {@link DescriptionRejectedError} when the provider refuses this capture
 * itself.
 */
export async function describePage(request: DescribePageRequest): Promise<PageEnrichment> {
  const content: UserContent = [{ type: 'text', text: describePrompt(request) }]
  if (request.screenshotBase64) {
    content.push({
      type: 'image',
      image: request.screenshotBase64,
      mediaType: 'image/jpeg',
    })
  }
  try {
    const result = await generateObject({
      model: languageModel(request.config, request.apiKey, request.fetchFn ?? fetch),
      schema: pageDescriptionSchema,
      messages: [{ role: 'user', content }],
      abortSignal: AbortSignal.timeout(DESCRIBE_TIMEOUT_MS),
      // The enrichment pass is the retry layer (next trigger re-runs pending
      // captures); the SDK's own backoff would only delay that.
      maxRetries: 0,
    })
    return {
      title: normalizedPageTitle(result.object.title),
      description: result.object.description.trim(),
    }
  } catch (cause) {
    throw classify(cause)
  }
}
