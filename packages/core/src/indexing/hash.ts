/**
 * Content hashing for change detection (Plan 04). Sync providers rewrite mtimes,
 * so the index compares a content hash, not just the modification time.
 */

/** Lowercase hex SHA-256 of `content` (via Web Crypto, available in the WebView). */
export async function hashContent(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
