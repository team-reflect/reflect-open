import { captureMetaFetch } from '../graph/commands'

/**
 * Meta-tag scraping for link capture (Plan 11) — the no-AI half of
 * enrichment: fetch the captured page (through the hard-capped Rust
 * `capture_meta_fetch` primitive) and pull `<title>`, the meta description,
 * and the OpenGraph basics out of the HTML. Parsing uses `DOMParser`
 * (native in the webview; tests run under jsdom), never regex over HTML.
 */

export interface PageMeta {
  /** `og:title`, falling back to `<title>`. */
  title: string | null
  /** `og:description`, falling back to `<meta name="description">`. */
  description: string | null
  /** `og:site_name`. */
  siteName: string | null
  /**
   * The page's preview image (`og:image`, falling back to `twitter:image`),
   * resolved to an absolute http(s) URL — the capture's screenshot stand-in
   * for shares that carry no pixels of their own.
   */
  image: string | null
}

/** Caps how much of a meta value survives — these render inline in notes. */
const MAX_META_CHARS = 500

function clean(value: string | null | undefined): string | null {
  const collapsed = value?.replace(/\s+/g, ' ').trim() ?? ''
  if (collapsed === '') {
    return null
  }
  return collapsed.slice(0, MAX_META_CHARS)
}

function metaContent(document: Document, selector: string): string | null {
  return clean(document.querySelector(selector)?.getAttribute('content'))
}

/**
 * Resolve a scraped image reference to an absolute http(s) URL, or `null`
 * when it is not one (a data: URI, a protocol we would refuse to fetch, an
 * unparseable value). URLs are never truncated — a clipped URL is broken.
 */
function imageUrl(value: string | null | undefined, baseUrl: string): string | null {
  const trimmed = value?.trim() ?? ''
  if (trimmed === '') {
    return null
  }
  try {
    const resolved = new URL(trimmed, baseUrl)
    return resolved.protocol === 'https:' || resolved.protocol === 'http:'
      ? resolved.toString()
      : null
  } catch {
    return null
  }
}

/**
 * Extract {@link PageMeta} from an HTML document's text; `baseUrl` resolves
 * relative image references. Never throws.
 */
export function parsePageMeta(html: string, baseUrl: string): PageMeta {
  const document = new DOMParser().parseFromString(html, 'text/html')
  return {
    title:
      metaContent(document, 'meta[property="og:title"]') ??
      clean(document.querySelector('title')?.textContent),
    description:
      metaContent(document, 'meta[property="og:description"]') ??
      metaContent(document, 'meta[name="description"]'),
    siteName: metaContent(document, 'meta[property="og:site_name"]'),
    image:
      imageUrl(
        document.querySelector('meta[property="og:image"]')?.getAttribute('content'),
        baseUrl,
      ) ??
      imageUrl(
        document.querySelector('meta[name="twitter:image"]')?.getAttribute('content'),
        baseUrl,
      ),
  }
}

/**
 * Fetch and parse one captured page's meta tags. Propagates the fetch's
 * typed errors (`network` for transient failures the enrichment pass should
 * retry, `io`/`parse` for permanent ones it should write through without).
 */
export async function scrapePageMeta(url: string): Promise<PageMeta> {
  return parsePageMeta(await captureMetaFetch(url), url)
}
