import { toAppError } from '../errors'
import { captureMetaFetch, captureJsonFetch } from '../graph/commands'
import { normalizePageMetaValue, parsePageMeta, type PageMeta } from '../link-preview/metadata'
import { oembedRequestURL, parseOEmbedAnswer } from './oembed'

/**
 * Meta-tag scraping for link capture (Plan 11) — the no-AI half of
 * enrichment: fetch the captured page (through the hard-capped Rust
 * `capture_meta_fetch` primitive) and pull `<title>`, the meta description,
 * and the OpenGraph basics out of the HTML. Parsing uses `DOMParser`
 * (native in the webview; tests run in a real browser), never regex over HTML.
 */

async function scrapeOEmbed(requestURL: string): Promise<PageMeta | null> {
  let json: string
  try {
    json = await captureJsonFetch(requestURL)
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
  const title = normalizePageMetaValue(answer.title)
  if (title === null) {
    return null
  }
  // oEmbed has no description field; the capture keeps none until (and
  // unless) the AI leg writes one, now grounded in this real title.
  return { title, description: null, siteName: normalizePageMetaValue(answer.providerName) }
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
