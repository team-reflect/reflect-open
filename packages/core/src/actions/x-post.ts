export const X_TEXT_MAX_LENGTH = 20_000
export const X_QUOTE_MAX_LENGTH = 5_000
export const X_IMAGE_LIMIT = 4
export const CAPTURE_ENVELOPE_MAX_BYTES = 64 * 1024

const X_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
])

/** Read a post ID from an X status permalink. */
export function xPostId(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !X_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  ) {
    return null
  }
  return (
    /^\/(?:\w+|i\/web)\/status\/(\d{1,20})(?:\/(?:photo|video)\/\d+)?\/?$/.exec(
      url.pathname,
    )?.[1] ?? null
  )
}

/** Canonical permalink independent of the author's current handle. */
export function xPostUrl(id: string): string {
  return `https://x.com/i/status/${id}`
}
