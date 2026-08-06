/**
 * Match-key folding (Plan 03/04).
 *
 * Note identity matching — wiki-link targets, note titles, and aliases — is
 * insensitive to case and surrounding whitespace. {@link foldKey} is the single
 * definition of that normalization, shared by the index write path
 * (`buildIndexedNote`) and the resolver (`normalizeWikiTarget`) so the keys
 * written to the index can never drift from the keys looked up against it.
 */

/**
 * Trim surrounding whitespace and case-fold `value` to its match key. NFC
 * first: macOS hands back NFD filenames, and a filename-derived key must
 * equal the same name typed by hand. Full Unicode lowering, unlike
 * `foldGraphPath`'s ASCII-only rule: name keys are compared between humans,
 * path keys are compared against the filesystem via Rust's byte-wise fold.
 * Mirrored by the CLI's `fold_key`; `fixtures/fold-key-parity.json` keeps the
 * two implementations honest.
 */
export function foldKey(value: string): string {
  return value.normalize('NFC').trim().toLowerCase()
}

/**
 * A conservative second-chance title key for unresolved wiki links.
 *
 * Exact {@link foldKey} matching always wins. This fallback only smooths the
 * title spellings a mobile editor can transiently produce around a leading
 * emoji: the emoji prefix is removed, Unicode whitespace is collapsed, and
 * the remainder is case-folded. Punctuation elsewhere stays significant, so
 * titles such as `C` and `C++` do not collapse together.
 *
 * Callers must accept a fallback match only when it is unique. Leading emoji
 * can be intentional identity (`🧠 Ideas` and `💡 Ideas`), so choosing the
 * first loose match would be worse than leaving the link unresolved.
 */
export function foldFallbackTitleKey(value: string): string {
  const folded = value.normalize('NFC').trim().toLowerCase().replaceAll(/\s+/gu, ' ')
  return folded.replace(LEADING_EMOJI_RE, '').trimStart()
}

// One or more leading emoji graphemes: pictographs (including skin tone / ZWJ
// sequences), regional-indicator flags, or keycaps. This deliberately does
// not strip arbitrary leading punctuation.
const PICTOGRAPH = String.raw`\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*`
const FLAG = String.raw`\p{Regional_Indicator}{2}`
const KEYCAP = String.raw`[#*0-9]\uFE0F?\u20E3`
const LEADING_EMOJI_RE = new RegExp(
  String.raw`^(?:(?:${PICTOGRAPH})|(?:${FLAG})|(?:${KEYCAP}))+\s*`,
  'u',
)

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
