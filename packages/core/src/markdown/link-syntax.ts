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
  /** Source range of the href, excluding optional `<…>` brackets. */
  destination: { from: number; to: number }
}

/**
 * Decompose the source of an inline link/image node, or `null` when it isn't
 * the inline form (for example, a reference-style link).
 */
export function parseInlineLink(source: string): InlineLinkParts | null {
  const match = INLINE_LINK_RE.exec(source)
  if (!match) {
    return null
  }
  // All three groups are mandatory in INLINE_LINK_RE, so a successful match
  // always populates them.
  const rawHref = match[3]!
  const hrefOffset = source.indexOf(rawHref, source.indexOf('](') + 2)
  if (hrefOffset === -1) {
    return null
  }
  const bracketed = rawHref.startsWith('<') && rawHref.endsWith('>')
  return {
    isImage: match[1] === '!',
    text: match[2]!,
    href: bracketed ? rawHref.slice(1, -1) : rawHref,
    destination: {
      from: hrefOffset + (bracketed ? 1 : 0),
      to: hrefOffset + rawHref.length - (bracketed ? 1 : 0),
    },
  }
}
