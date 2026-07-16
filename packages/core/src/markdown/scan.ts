import { parseBody } from './grammar'
import { parseInlineLink } from './link-syntax'
import { isWikiNodeName, wikiBracketStart } from './wiki-nodes'

/**
 * Inline scanning for the editor (Plan 05). The editor decorates `[[wiki
 * links]]` and renders `![images](…)` inside text blocks; these scanners reuse
 * the **one canonical Lezer grammar** (shared with the indexer) so the editor
 * and the index can never disagree on what counts as a link or image —
 * including code contexts: `[[target]]` or `![x](y)` inside a code span is
 * literal text in both worlds.
 */

/** One `[[target]]` / `[[target|alias]]` occurrence within a scanned text. */
export interface InlineWikiLink {
  /** Span of the whole `[[…]]`, offsets relative to the scanned text. */
  from: number
  to: number
  target: string
  alias: string | null
  /** Span of the display text (the alias when present, else the target). */
  displayFrom: number
  displayTo: number
}

/** One `![alt](src)` image occurrence within a scanned text. */
export interface InlineImage {
  /** Span of the whole `![…](…)`, offsets relative to the scanned text. */
  from: number
  to: number
  alt: string
  src: string
}

/**
 * Find every inline image in a block's text content. Offsets are relative to
 * the input string; the caller maps them into document positions. Source
 * decomposition is shared with the indexer (`link-syntax.ts`), so the editor
 * renders exactly what the index records.
 */
export function scanInlineImages(text: string): InlineImage[] {
  if (!text.includes('![')) {
    return []
  }
  const images: InlineImage[] = []
  parseBody(text).iterate({
    enter: (node) => {
      if (node.name !== 'Image') {
        return true
      }
      const parsed = parseInlineLink(text.slice(node.from, node.to))
      if (parsed?.isImage) {
        images.push({ from: node.from, to: node.to, alt: parsed.text, src: parsed.href })
      }
      return false
    },
  })
  return images
}

/**
 * An ordered piece of inline content: literal text, a `[[wiki]]` link, or a
 * markdown/autolink link. {@link scanInlineSegments} returns these in document
 * order so a renderer can style links without re-parsing.
 */
export type InlineSegment =
  | { kind: 'text'; text: string }
  | { kind: 'wikiLink'; target: string; alias: string | null }
  | { kind: 'link'; text: string; href: string }

/**
 * Split inline `text` into ordered segments through the **one canonical Lezer
 * grammar** (GFM + wiki links) — the same parser the editor and indexer use, so
 * what counts as a link can't drift, and a `[[link]]`/`[text](url)`/bare URL
 * inside a code span stays literal text. Used by the Tasks view to render a
 * task's content with styled date/link chips without a fragile regex.
 *
 * Emphasis and other inline marks aren't segmented — their text (with markers)
 * falls into the surrounding `text` segments, rendered as written.
 */
export function scanInlineSegments(text: string): InlineSegment[] {
  const found: Array<{ from: number; to: number; segment: InlineSegment }> = []
  parseBody(text).iterate({
    enter: (node) => {
      const { name, to } = node
      if (isWikiNodeName(name)) {
        const from = wikiBracketStart(node)
        const inner = text.slice(from + 2, to - 2)
        const pipe = inner.indexOf('|')
        const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim()
        const alias = pipe === -1 ? null : inner.slice(pipe + 1).trim() || null
        found.push({ from, to, segment: { kind: 'wikiLink', target, alias } })
        return false
      }
      const { from } = node
      if (name === 'Link' || name === 'Image') {
        const parsed = parseInlineLink(text.slice(from, to))
        if (parsed === null) {
          return true // reference-style/non-inline link — leave as literal text
        }
        found.push({ from, to, segment: { kind: 'link', text: parsed.text, href: parsed.href } })
        return false
      }
      // A GFM-autolinked bare URL surfaces as a top-level `URL` node; `<…>`
      // autolinks as `Autolink`. (URLs *inside* a Link/Autolink are never reached
      // — we don't recurse into those.) Both render as their own link.
      if (name === 'URL' || name === 'Autolink') {
        const href = text.slice(from, to).replace(/^<|>$/g, '')
        found.push({ from, to, segment: { kind: 'link', text: href, href } })
        return false
      }
      return true
    },
  })

  found.sort((left, right) => left.from - right.from)
  const segments: InlineSegment[] = []
  let cursor = 0
  for (const node of found) {
    if (node.from > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, node.from) })
    }
    segments.push(node.segment)
    cursor = node.to
  }
  if (cursor < text.length) {
    segments.push({ kind: 'text', text: text.slice(cursor) })
  }
  return segments
}

/**
 * Find every wiki link in a block's text content. Offsets are relative to the
 * input string; the caller maps them into document positions.
 */
export function scanInlineWikiLinks(text: string): InlineWikiLink[] {
  if (!text.includes('[[')) {
    return [] // cheap pre-filter — most blocks have no wiki links
  }
  const links: InlineWikiLink[] = []
  parseBody(text).iterate({
    enter: (node) => {
      if (!isWikiNodeName(node.name)) {
        return true
      }
      const { to } = node
      const from = wikiBracketStart(node)
      const inner = text.slice(from + 2, to - 2)
      const pipe = inner.indexOf('|')
      const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim()
      const alias = pipe === -1 ? null : inner.slice(pipe + 1).trim() || null
      // Display text: the alias segment when a real alias exists, else the
      // target segment — a blank alias (`[[target|  ]]`) falls back to target.
      const displayFrom = alias !== null ? from + 2 + pipe + 1 : from + 2
      const displayTo = alias !== null ? to - 2 : from + 2 + (pipe === -1 ? inner.length : pipe)
      links.push({ from, to, target, alias, displayFrom, displayTo })
      return false
    },
  })
  return links
}
