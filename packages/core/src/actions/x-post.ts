/** Decimal post IDs remain strings to preserve their precision. */
export const X_POST_ID = /^[1-9]\d{0,19}$/

const X_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
])
const POST_PATH =
  /^\/(?:i(?:\/web)?|\w{1,15})\/status\/([1-9]\d{0,19})(?:\/(?:photo|video)\/[1-9]\d*)?\/?$/

/** Read the ID of an X permalink, including legacy Twitter spellings. */
export function xPostId(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(url.protocol) || !X_HOSTS.has(url.hostname)) return null
  if (url.username || url.password || url.port) return null
  return POST_PATH.exec(url.pathname)?.[1] ?? null
}

/** The stable, account-independent permalink for a post. */
export function xPostURL(id: string): string {
  if (!X_POST_ID.test(id)) throw new Error('invalid X post ID')
  return `https://x.com/i/status/${id}`
}
