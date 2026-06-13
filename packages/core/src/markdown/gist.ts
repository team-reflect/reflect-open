/**
 * Pure gist-publishing content helpers: the body hash that drives the
 * "Republish" nudge and the filename a note publishes under. They live in the
 * markdown domain (not sync) because the indexer recomputes the hash on every
 * re-index — publish-time and index-time must share one definition or
 * staleness would flicker.
 */

/**
 * Hash of a note body as published to a gist — compared against the
 * frontmatter `gist.hash` to derive `gist_stale`. Staleness is deliberately a
 * *content* comparison: publishing writes the `gist` frontmatter block, which
 * bumps the file's mtime, so any time-based check would flag a note as
 * changed the instant it was published.
 *
 * FNV-1a over UTF-8, two 32-bit passes with different seeds folded into 16
 * hex chars. Synchronous on purpose — it runs inside the index projection
 * (`buildIndexedNote`, a pure sync function) — and not cryptographic: it
 * detects the user's own edits, nothing adversarial.
 */
export function gistBodyHash(body: string): string {
  const bytes = new TextEncoder().encode(body)
  return fnv1a32(bytes, 0x811c9dc5) + fnv1a32(bytes, 0x811c9dc5 ^ 0x5bd1e995)
}

function fnv1a32(bytes: Uint8Array, seed: number): string {
  let hash = seed >>> 0
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * The gist filename for a note title: `<title>.md`, so the gist renders as
 * markdown under a human name (dailies' titles are already their ISO date).
 * Path separators would read as structure that isn't there — they fold to
 * dashes — and an empty or whitespace title falls back to `Untitled`.
 */
export function gistFilename(title: string): string {
  const safe = title.replace(/[/\\]/g, '-').trim()
  return `${safe === '' ? 'Untitled' : safe}.md`
}
