/**
 * Match-key folding (Plan 03/04).
 *
 * Note identity matching — wiki-link targets, note titles, and aliases — is
 * insensitive to case and surrounding whitespace. {@link foldKey} is the single
 * definition of that normalization, shared by the index write path
 * (`buildIndexedNote`) and the resolver (`normalizeWikiTarget`) so the keys
 * written to the index can never drift from the keys looked up against it.
 */

/** Trim surrounding whitespace and case-fold `value` to its match key. */
export function foldKey(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Case-fold a tag name to its match key (`#Book` ≡ `#book`). The one
 * definition of tag folding, shared by the indexer (`tags.tag_key`), the
 * search filter grammar, and every UI surface that compares or dedupes tags.
 * Folding happens here, in Unicode-aware JS, and the folded key is *stored* —
 * SQLite's `lower()` is ASCII-only, so folding in SQL would split `#Café`
 * from `#café`. (No trim: the tag grammar already excludes whitespace.)
 */
export function foldTag(value: string): string {
  return value.toLowerCase()
}
