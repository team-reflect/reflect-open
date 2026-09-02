/**
 * Post permalinks on X (Plan 25): recognizing one, and the one canonical
 * spelling every producer and the drain agree on. Deliberately dependency-free
 * and browser-safe — the extension consumes it through the package's
 * `./post-url` subpath, exactly like `./capture-envelope`.
 */

/** A parsed post permalink. */
export interface PostPermalink {
  readonly provider: 'x'
  /** The numeric post id (a Twitter snowflake). */
  readonly id: string
  /** The author's handle from the URL, or `null` for `/i/status/<id>` forms. */
  readonly handle: string | null
  /** `https://x.com/<handle>/status/<id>`, or `https://x.com/i/status/<id>`. */
  readonly url: string
}

const X_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
])

/** X handles: 1–15 in practice, but the platform accepts up to 50 word characters. */
export const POST_HANDLE_RE = /^\w{1,50}$/

/** Post ids are decimal snowflakes; `/^\d+$/` with a sane length cap. */
export const POST_ID_RE = /^\d{1,40}$/

/** The permalink for a post id, with the author's handle when known. */
export function postPermalink(id: string, handle: string | null): string {
  return handle === null ? `https://x.com/i/status/${id}` : `https://x.com/${handle}/status/${id}`
}

/**
 * Parse a post permalink in any of X's spellings — `x.com`/`twitter.com`,
 * mobile hosts, `/<handle>/status/<id>` (with `/photo/1`-style suffixes),
 * `/i/web/status/<id>`, `/i/status/<id>` — or `null` for anything else
 * (profiles, timelines, the bookmarks page, non-X URLs).
 */
export function parsePostUrl(value: string): PostPermalink | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !X_HOSTS.has(url.hostname)) {
    return null
  }
  const segments = url.pathname.split('/').filter((segment) => segment !== '')
  const [first, second, third, fourth] = segments
  if (first === 'i') {
    const id =
      second === 'web' && third === 'status' ? fourth : second === 'status' ? third : undefined
    return id !== undefined && POST_ID_RE.test(id)
      ? { provider: 'x', id, handle: null, url: postPermalink(id, null) }
      : null
  }
  if (first === undefined || second !== 'status' || third === undefined) {
    return null
  }
  if (!POST_HANDLE_RE.test(first) || !POST_ID_RE.test(third)) {
    return null
  }
  return { provider: 'x', id: third, handle: first, url: postPermalink(third, first) }
}

/** Is this URL a post permalink? */
export function isPostUrl(value: string): boolean {
  return parsePostUrl(value) !== null
}

/** The profile URL for a handle. */
export function profileUrl(handle: string): string {
  return `https://x.com/${handle}`
}
