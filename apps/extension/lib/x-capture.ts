export const X_CAPTURE_CHANNEL = 'reflect-x-capture'

/** Read the post ID from an X permalink, including its photo/video subpages. */
// FIXME: duplicate of `parseXPostId` from `@post-embed/types` (background.ts already imports it).
// Delete this function; keep only the channel constant.
export function permalinkPostId(source: string | undefined): string | undefined {
  if (!source) return
  let url: URL
  try {
    url = new URL(source)
  } catch {
    return
  }
  if (url.origin !== 'https://x.com') return
  return /^\/(?:[^/]+|i\/web)\/status\/([1-9]\d{0,19})(?:\/|$)/.exec(url.pathname)?.[1]
}
