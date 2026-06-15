import type { Span } from './model'

/**
 * Plain-text rendering (Plan 03): turn a slice of markdown body into the text a
 * reader sees — emphasis/marker syntax dropped, wiki brackets/pipes flattened,
 * backslash escapes resolved, code spans kept literal. Shared by {@link parseNote}
 * for the whole-body FTS/AI text and by each task's display text, so a task
 * renders exactly as the note's body does.
 *
 * The walk in `extract.ts` supplies two span sets in body coordinates: `cuts`
 * (syntax ranges to drop — `*emphasis*` marks, the `[ ]` TaskMarker, URLs) and
 * `literalRanges` (code regions whose backslashes stay verbatim). This module is
 * pure string surgery over those spans; it does no parsing of its own.
 */

// Inner of a wiki link, for plain-text rendering.
const WIKI_INNER_RE = /\[\[([^\]\n]*)\]\]/g
// CommonMark backslash escapes are visible in source, but not rendered text.
const MARKDOWN_ESCAPE_RE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g

/** Resolve CommonMark backslash escapes (`\*` → `*`). */
export function unescapeMarkdownText(text: string): string {
  return text.replace(MARKDOWN_ESCAPE_RE, '$1')
}

function renderMarkdownText(text: string): string {
  return text
    .replace(WIKI_INNER_RE, (_, inner: string) => inner.replace(/\|/g, ' '))
    .replace(MARKDOWN_ESCAPE_RE, '$1')
}

function appendPlainTextChunk(
  body: string,
  from: number,
  to: number,
  literalRanges: Span[],
): string {
  let kept = ''
  let cursor = from
  for (const literalRange of literalRanges) {
    if (literalRange.to <= cursor) {
      continue
    }
    if (literalRange.from >= to) {
      break
    }

    const literalFrom = Math.max(cursor, literalRange.from)
    const literalTo = Math.min(to, literalRange.to)
    if (cursor < literalFrom) {
      kept += renderMarkdownText(body.slice(cursor, literalFrom))
    }
    kept += body.slice(literalFrom, literalTo)
    cursor = literalTo
  }
  if (cursor < to) {
    kept += renderMarkdownText(body.slice(cursor, to))
  }
  return kept
}

/**
 * Plain text of `[start, end)` minus the cut (syntax) ranges, with wiki
 * brackets/pipes flattened. Shared by the whole-body plain text and per-task
 * text so a task renders exactly as the note's body does (emphasis marks and
 * the `[ ]` TaskMarker dropped, code kept literal).
 */
export function plainTextOfRange(
  body: string,
  start: number,
  end: number,
  cuts: Span[],
  literalRanges: Span[],
): string {
  const sorted = [...cuts].sort((a, b) => a.from - b.from)
  const sortedLiteralRanges = [...literalRanges].sort((a, b) => a.from - b.from)
  let kept = ''
  let pos = start
  for (const cut of sorted) {
    if (cut.to <= start) {
      continue
    }
    if (cut.from >= end) {
      break
    }
    const cutFrom = Math.max(start, cut.from)
    if (cutFrom > pos) {
      kept += appendPlainTextChunk(body, pos, cutFrom, sortedLiteralRanges)
    }
    pos = Math.max(pos, Math.min(end, cut.to))
  }
  if (pos < end) {
    kept += appendPlainTextChunk(body, pos, end, sortedLiteralRanges)
  }
  return kept.replace(/\s+/g, ' ').trim()
}

/** Body text minus the cut (syntax) ranges, with wiki brackets/pipes flattened. */
export function buildPlainText(body: string, cuts: Span[], literalRanges: Span[]): string {
  return plainTextOfRange(body, 0, body.length, cuts, literalRanges)
}
