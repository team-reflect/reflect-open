import { toAppError } from '../errors'
import { captureMetaFetch, captureOEmbedFetch } from '../graph/commands'
import { oembedRequestURL, parseOEmbedAnswer } from './oembed'

/**
 * Meta-tag scraping for link capture (Plan 11) — the no-AI half of
 * enrichment: fetch the captured page (through the hard-capped Rust
 * `capture_meta_fetch` primitive) and pull `<title>`, the meta description,
 * and the OpenGraph basics out of the HTML. Parsing uses `DOMParser`
 * (native in the webview; tests run in a real browser), never regex over HTML.
 */

export interface PageMeta {
  /** `og:title`, falling back to `<title>`. */
  title: string | null
  /** `og:description`, falling back to `<meta name="description">`. */
  description: string | null
  /** `og:site_name`. */
  siteName: string | null
}

/** Caps how much of a meta value survives — these render inline in notes. */
const MAX_META_CHARS = 500

function clean(value: string | null | undefined): string | null {
  const collapsed = value?.replaceAll(/\s+/g, ' ').trim() ?? ''
  if (collapsed === '') {
    return null
  }
  return collapsed.slice(0, MAX_META_CHARS)
}

function metaContent(document: Document, selector: string): string | null {
  return clean(document.querySelector(selector)?.getAttribute('content'))
}

/** Extract {@link PageMeta} from an HTML document's text. Never throws. */
export function parsePageMeta(html: string): PageMeta {
  const document = new DOMParser().parseFromString(html, 'text/html')
  return {
    title:
      metaContent(document, 'meta[property="og:title"]') ??
      clean(document.querySelector('title')?.textContent),
    description:
      metaContent(document, 'meta[property="og:description"]') ??
      metaContent(document, 'meta[name="description"]'),
    siteName: metaContent(document, 'meta[property="og:site_name"]'),
  }
}

async function scrapeOEmbed(requestURL: string): Promise<PageMeta | null> {
  let json: string
  try {
    json = await captureOEmbedFetch(requestURL)
  } catch (cause) {
    const kind = toAppError(cause).kind
    if (kind === 'network' || kind === 'auth') {
      throw cause
    }
    // A refused id (400), a private or embed-disabled video (401/403), and a
    // non-JSON answer are permanent for the shortcut; the generic HTML
    // scrape still gets its turn.
    return null
  }
  const answer = parseOEmbedAnswer(json)
  if (answer === null) {
    return null
  }
  const title = clean(answer.title)
  if (title === null) {
    return null
  }
  // oEmbed has no description field; the capture keeps none until (and
  // unless) the AI leg writes one, now grounded in this real title.
  return { title, description: null, siteName: clean(answer.providerName) }
}

/**
 * Fetch and parse one captured page's meta tags. URLs a registered oEmbed
 * provider claims (see `actions/oembed`) resolve through that provider's
 * endpoint first; every other page, and any claimed URL whose oEmbed attempt
 * failed permanently, takes the generic HTML scrape. Propagates the fetch's
 * typed errors (`network` for transient failures the enrichment pass should
 * retry, `io`/`parse` for permanent ones it should write through without).
 */
export async function scrapePageMeta(url: string): Promise<PageMeta> {
  const requestURL = oembedRequestURL(url)
  if (requestURL !== null) {
    const meta = await scrapeOEmbed(requestURL)
    if (meta !== null) {
      return meta
    }
  }
  return parsePageMeta(await captureMetaFetch(url))
}
