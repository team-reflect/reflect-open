/**
 * The one source-level parser for inline `[text](href)` / `![alt](href)`
 * spans, shared by extraction (`extract.ts`, feeding the index) and the
 * editor scanners (`scan.ts`). Lezer locates the nodes; this decomposes their
 * source text — keeping it in one place means the index and the editor can
 * never disagree on hrefs, titles, or bracketed targets.
 */

/** `[text](href)` / `![alt](href)`, tolerating a "title" suffix and <bracketed> href. */
const INLINE_LINK_RE =
  /^(!?)\[([^\]]*)\]\(\s*(<[^>]*>|\S+?)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)$/

/** The decomposed parts of one inline link/image source span. */
export interface InlineLinkParts {
  /** True for the `![…](…)` image form. */
  isImage: boolean
  /** Link text / image alt (may be empty). */
  text: string
  /** The href with any `<…>` brackets removed. */
  href: string
}

/**
 * Decompose the source of an inline link/image node, or `null` when it isn't
 * the inline form (e.g. a reference-style link — skipped this wave).
 */
export function parseInlineLink(source: string): InlineLinkParts | null {
  const match = INLINE_LINK_RE.exec(source)
  if (!match) {
    return null
  }
  // All three groups are mandatory in INLINE_LINK_RE, so a successful match
  // always populates them.
  return {
    isImage: match[1] === '!',
    text: match[2]!,
    href: match[3]!.replace(/^<|>$/g, ''),
  }
}
