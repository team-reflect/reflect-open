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

/**
 * Fetch and parse one captured page's meta tags. Propagates the fetch's
 * typed errors (`network` for transient failures the enrichment pass should
 * retry, `io`/`parse` for permanent ones it should write through without).
 */
export async function scrapePageMeta(url: string): Promise<PageMeta> {
  return parsePageMeta(await captureMetaFetch(url))
}
