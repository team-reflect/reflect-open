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
 * Parse a rendered link href as a graph-relative PDF address:
 * `assets/…pdf`, matched case-insensitively, with an optional `#page=N`
 * (1-based) fragment. Returns null for anything the shape doesn't name — a
 * non-PDF asset, a relative link outside `assets/`, a URL with a scheme, or a
 * fragment that isn't a page target. The path keeps its authored casing; only
 * the *match* is case-insensitive.
 */
export function parsePdfHref(href: string): PdfLinkRef | null {
  const [rawPath, fragment] = href.split('#')
  const path = rawPath!.split('?')[0]!
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
