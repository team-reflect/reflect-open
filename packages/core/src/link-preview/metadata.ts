import { z } from 'zod'

/** Metadata shared by capture enrichment and editor link previews. */

export interface PageMeta {
  /** `og:title`, falling back to `<title>`. */
  readonly title: string | null
  /** `og:description`, falling back to `<meta name="description">`. */
  readonly description: string | null
  /** `og:site_name`. */
  readonly siteName: string | null
}

/** Display metadata extracted for an editor link preview. */
export interface LinkPreviewMeta {
  /** A bounded `og:title` or document title. */
  readonly title: string
  /** A bounded OpenGraph or standard description. */
  readonly description: string | null
  /** A declared raster icon URL, or the conventional `/favicon.ico`. */
  readonly iconUrl: string
}

const MAX_PAGE_META_CHARS = 500
const MAX_LINK_TITLE_CHARS = 200
const MAX_LINK_DESCRIPTION_CHARS = 300

const pageMetaSchema: z.ZodType<PageMeta> = z.object({
  title: z.string().min(1).max(MAX_PAGE_META_CHARS).nullable(),
  description: z.string().min(1).max(MAX_PAGE_META_CHARS).nullable(),
  siteName: z.string().min(1).max(MAX_PAGE_META_CHARS).nullable(),
})

const linkPreviewMetaSchema: z.ZodType<LinkPreviewMeta> = z.object({
  title: z.string().min(1).max(MAX_LINK_TITLE_CHARS),
  description: z.string().min(1).max(MAX_LINK_DESCRIPTION_CHARS).nullable(),
  iconUrl: z.url().refine((value) => {
    try {
      const protocol = new URL(value).protocol
      return protocol === 'https:' || protocol === 'http:'
    } catch {
      return false
    }
  }),
})

/** Collapse metadata whitespace, reject blanks, and cap its display length. */
export function normalizePageMetaValue(
  value: string | null | undefined,
  maxCharacters = MAX_PAGE_META_CHARS,
): string | null {
  const collapsed = value?.replaceAll(/\s+/g, ' ').trim() ?? ''
  return collapsed === '' ? null : collapsed.slice(0, maxCharacters)
}

function metaContent(document: Document, selector: string): string | null {
  return normalizePageMetaValue(document.querySelector(selector)?.getAttribute('content'))
}

function pageMetaFromDocument(document: Document): PageMeta {
  return {
    title:
      metaContent(document, 'meta[property="og:title"]') ??
      normalizePageMetaValue(document.querySelector('title')?.textContent),
    description:
      metaContent(document, 'meta[property="og:description"]') ??
      metaContent(document, 'meta[name="description"]'),
    siteName: metaContent(document, 'meta[property="og:site_name"]'),
  }
}

/** Extract {@link PageMeta} from an HTML document's text. Never throws. */
export function parsePageMeta(html: string): PageMeta {
  const parsed = pageMetaSchema.safeParse(
    pageMetaFromDocument(new DOMParser().parseFromString(html, 'text/html')),
  )
  return parsed.success ? parsed.data : { title: null, description: null, siteName: null }
}

function rasterIconUrl(document: Document, pageUrl: string): string {
  for (const element of document.querySelectorAll<HTMLLinkElement>('link[rel][href]')) {
    const relationships = element.rel.toLowerCase().split(/\s+/)
    if (
      !relationships.includes('icon') &&
      !relationships.includes('apple-touch-icon') &&
      !relationships.includes('apple-touch-icon-precomposed')
    ) {
      continue
    }
    if (element.type.trim().toLowerCase().includes('svg')) continue
    try {
      const url = new URL(element.getAttribute('href') ?? '', pageUrl)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue
      if (url.pathname.toLowerCase().endsWith('.svg')) continue
      return url.href
    } catch {
      continue
    }
  }
  return new URL('/favicon.ico', pageUrl).href
}

/**
 * Parse editor link-preview metadata and resolve its favicon against the final
 * page URL after redirects. A missing title is not a usable rich preview.
 */
export function parseLinkPreviewMeta(html: string, finalUrl: string): LinkPreviewMeta | null {
  const document = new DOMParser().parseFromString(html, 'text/html')
  const page = pageMetaFromDocument(document)
  const title = normalizePageMetaValue(page.title, MAX_LINK_TITLE_CHARS)
  if (title === null) return null
  let iconUrl: string
  try {
    iconUrl = rasterIconUrl(document, finalUrl)
  } catch {
    return null
  }
  const parsed = linkPreviewMetaSchema.safeParse({
    title,
    description: normalizePageMetaValue(page.description, MAX_LINK_DESCRIPTION_CHARS),
    iconUrl,
  })
  return parsed.success ? parsed.data : null
}
