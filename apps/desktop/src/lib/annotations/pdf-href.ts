/**
 * A rendered PDF link address, carved out of a markdown href.
 */

export interface PdfLinkRef {
  /** The graph-relative `assets/…pdf` path, with any `#fragment`/`?query` stripped. */
  path: string
  /** The 1-based page from an optional `#page=N` fragment. */
  page?: number
}

/**
 * Decode a URL-encoded graph-relative path (`%20`, `%E4%B8%AD`…) back to its
 * on-disk form. Migration-produced links and rendered hrefs can carry
 * percent-encoding for spaces and non-ASCII characters, while the file
 * commands resolve literal paths — the decoded form is the canonical one.
 * Malformed sequences fall back to the raw string rather than throwing.
 */
export function decodeAssetHref(href: string): string {
  try {
    return decodeURIComponent(href)
  } catch {
    return href
  }
}

/**
 * Parse a rendered link href as a graph-relative PDF address:
 * `assets/…pdf`, matched case-insensitively, with an optional `#page=N`
 * (1-based) fragment. Returns null for anything the shape doesn't name — a
 * non-PDF asset, a relative link outside `assets/`, a URL with a scheme, a
 * fragment that isn't a page target, a second `#` (an ambiguous address), or
 * a `..` path segment (an encoded `%2e%2e` could walk out of the graph's
 * assets directory). The path is URL-decoded to its on-disk form and keeps
 * its authored casing; only the *match* is case-insensitive.
 */
export function parsePdfHref(href: string): PdfLinkRef | null {
  const parts = href.split('#')
  if (parts.length > 2) {
    return null
  }
  const rawPath = parts[0] ?? ''
  const fragment = parts[1]
  const path = decodeAssetHref(rawPath.split('?')[0] ?? '')
  // Segment-level check: any `..` segment (raw or percent-encoded) could
  // traverse out of the assets directory, so it is rejected outright.
  if (path.split('/').includes('..')) {
    return null
  }
  if (!/^assets\/.+\.pdf$/i.test(path)) {
    return null
  }
  let page: number | undefined
  if (fragment !== undefined) {
    const match = /^page=(\d+)$/i.exec(fragment)
    if (match === null) {
      return null
    }
    const parsed = Number(match[1])
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      return null
    }
    page = parsed
  }
  return { path, ...(page !== undefined ? { page } : {}) }
}
