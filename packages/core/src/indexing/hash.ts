/**
 * Content hashing for change detection (Plan 04). Sync providers rewrite mtimes,
 * so the index compares a content hash, not just the modification time.
 */

/** Lowercase hex SHA-256 of `content` (via Web Crypto, available in the WebView). */
export async function hashContent(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * How old a file's mtime must be before an mtime match may skip the read.
 * Local write echoes stamp rows with `Date.now()`, so two saves landing in
 * the same millisecond could otherwise read as "unchanged"; anything still
 * changing settles within seconds, after which a matching mtime is safe.
 */
export const MTIME_TRUST_AGE_MS = 5_000

/**
 * Can a pass skip *reading* this file because the indexed row already
 * matches its on-disk mtime? A layer in front of the hash, not a
 * replacement: hashes stay the authority for "did the content change"
 * (providers rewrite mtimes — a differing mtime with identical content
 * still skips the write via the hash). This only avoids the read+hash for
 * the overwhelmingly common case of a file untouched since it was indexed.
 * Fails open: a missing or fresh mtime means "read it".
 */
export function matchesTrustedMtime(
  storedMtime: number | undefined,
  fileMtime: number | undefined,
  now: number,
): boolean {
  return (
    storedMtime !== undefined &&
    fileMtime !== undefined &&
    storedMtime === fileMtime &&
    now - fileMtime >= MTIME_TRUST_AGE_MS
  )
}
