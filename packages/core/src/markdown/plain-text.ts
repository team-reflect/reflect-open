import { LEZER_NODE_IDS, parseInline, type InlineElement } from '@meowdown/markdown'
import type { Span } from './model.ts'

/**
 * Plain-text rendering (Plan 03): the text a reader sees once emphasis and
 * marker syntax are dropped, wiki brackets and pipes are flattened, backslash
 * escapes are resolved, and code spans are kept literal. It feeds the UI slots
 * that render a plain string rather than Markdown (the All Notes row preview,
 * task rows and their breadcrumbs).
 */

// Inner of a wiki link, for plain-text rendering.
const WIKI_INNER_RE = /\[\[([^\]\n]*)\]\]/g
// CommonMark backslash escapes are visible in source, but not rendered text.
const MARKDOWN_ESCAPE_RE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g

/** Resolve CommonMark backslash escapes (`\*` → `*`). */
export function unescapeMarkdownText(text: string): string {
  return text.replaceAll(MARKDOWN_ESCAPE_RE, '$1')
}

function renderMarkdownText(text: string): string {
  return text
    .replaceAll(WIKI_INNER_RE, (_, inner: string) => inner.replaceAll('|', ' '))
    .replaceAll(MARKDOWN_ESCAPE_RE, '$1')
}

/** Render `[from, to)`, keeping the literal (code) ranges verbatim. */
function renderChunk(body: string, from: number, to: number, literalRanges: Span[]): string {
  let kept = ''
  let cursor = from
  for (const literal of literalRanges) {
    if (literal.to <= cursor) continue
    if (literal.from >= to) break
    const literalFrom = Math.max(cursor, literal.from)
    const literalTo = Math.min(to, literal.to)
    if (cursor < literalFrom) kept += renderMarkdownText(body.slice(cursor, literalFrom))
    kept += body.slice(literalFrom, literalTo)
    cursor = literalTo
  }
  if (cursor < to) kept += renderMarkdownText(body.slice(cursor, to))
  return kept
}

/**
 * Body text minus the cut (syntax) ranges, with wiki brackets/pipes flattened.
 * `cuts` are the syntax spans to drop (emphasis marks, task markers, URLs) and
 * `literalRanges` the code regions whose backslashes stay verbatim, both in
 * body coordinates.
 */
export function buildPlainText(body: string, cuts: Span[], literalRanges: Span[]): string {
  const sortedCuts = [...cuts].sort((a, b) => a.from - b.from)
  const sortedLiterals = [...literalRanges].sort((a, b) => a.from - b.from)
  let kept = ''
  let pos = 0
  for (const cut of sortedCuts) {
    if (cut.to <= 0) continue
    if (cut.from >= body.length) break
    const cutFrom = Math.max(0, cut.from)
    if (cutFrom > pos) kept += renderChunk(body, pos, cutFrom, sortedLiterals)
    pos = Math.max(pos, Math.min(body.length, cut.to))
  }
  if (pos < body.length) kept += renderChunk(body, pos, body.length, sortedLiterals)
  return kept.replaceAll(/\s+/g, ' ').trim()
}

// Syntax-only nodes that render as nothing.
const INLINE_MARKS = new Set<number>([
  LEZER_NODE_IDS.EmphasisMark,
  LEZER_NODE_IDS.LinkMark,
  LEZER_NODE_IDS.StrikethroughMark,
  LEZER_NODE_IDS.CodeMark,
  LEZER_NODE_IDS.HighlightMark,
  LEZER_NODE_IDS.InlineMathMark,
  LEZER_NODE_IDS.WikilinkMark,
  LEZER_NODE_IDS.WikiEmbedMark,
])
// Parts of a link that are not its label.
const LINK_INTERNALS = new Set<number>([
  LEZER_NODE_IDS.URL,
  LEZER_NODE_IDS.LinkTitle,
  LEZER_NODE_IDS.LinkLabel,
])

/** Render inline Markdown as a compact display string. */
export function inlineMarkdownToDisplayText(markdown: string): string {
  function render(
    nodes: readonly InlineElement[],
    from: number,
    to: number,
    literal = false,
    link = false,
  ): string {
    let result = ''
    let cursor = from
    const text = (value: string) => (literal ? value : unescapeMarkdownText(value))
    for (const node of nodes) {
      result += text(markdown.slice(cursor, node.from))
      if (node.type === LEZER_NODE_IDS.Wikilink || node.type === LEZER_NODE_IDS.WikiEmbed) {
        const open = node.type === LEZER_NODE_IDS.WikiEmbed ? 3 : 2
        const inner = markdown.slice(node.from + open, node.to - 2)
        result += unescapeMarkdownText(
          inner.includes('|') ? inner.slice(inner.indexOf('|') + 1) : inner,
        )
      } else if (!INLINE_MARKS.has(node.type) && !(link && LINK_INTERNALS.has(node.type))) {
        result +=
          node.children.length > 0
            ? render(
                node.children,
                node.from,
                node.to,
                literal || node.type === LEZER_NODE_IDS.InlineCode,
                node.type === LEZER_NODE_IDS.Link || node.type === LEZER_NODE_IDS.Image,
              )
            : text(markdown.slice(node.from, node.to))
      }
      cursor = node.to
    }
    return result + text(markdown.slice(cursor, to))
  }
  return render(parseInline(markdown), 0, markdown.length).replaceAll(/\s+/g, ' ').trim()
}
