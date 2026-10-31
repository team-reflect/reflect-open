import { LEZER_NODE_IDS, parseInline, type InlineElement } from '@meowdown/markdown'

const DROPPED_NODES: ReadonlySet<number> = new Set([
  LEZER_NODE_IDS.EmphasisMark,
  LEZER_NODE_IDS.StrikethroughMark,
  LEZER_NODE_IDS.HighlightMark,
  LEZER_NODE_IDS.InlineMathMark,
  LEZER_NODE_IDS.LinkMark,
  LEZER_NODE_IDS.LinkTitle,
  LEZER_NODE_IDS.LinkLabel,
  LEZER_NODE_IDS.CodeMark,
  LEZER_NODE_IDS.WikilinkMark,
  LEZER_NODE_IDS.WikiEmbedMark,
  LEZER_NODE_IDS.Comment,
  LEZER_NODE_IDS.HTMLTag,
])

/**
 * The text a reader sees for one paragraph of Markdown: marks dropped, links
 * reduced to their text, wiki links to their alias or target, escapes resolved,
 * code kept literal, whitespace collapsed.
 */
export function renderInlineText(markdown: string): string {
  const rendered = renderElements(markdown, parseInline(markdown), 0, markdown.length, false)
  return rendered.replaceAll(/\s+/g, ' ').trim()
}

function renderElements(
  text: string,
  elements: readonly InlineElement[],
  from: number,
  to: number,
  insideLink: boolean,
): string {
  let out = ''
  let cursor = from
  for (const element of elements) {
    out += text.slice(cursor, element.from)
    out += renderElement(text, element, insideLink)
    cursor = element.to
  }
  return out + text.slice(cursor, to)
}

function renderElement(text: string, element: InlineElement, insideLink: boolean): string {
  const { type, from, to, children } = element
  if (DROPPED_NODES.has(type)) {
    return ''
  }
  if (type === LEZER_NODE_IDS.URL) {
    return insideLink ? '' : text.slice(from, to)
  }
  if (type === LEZER_NODE_IDS.Escape) {
    return text.slice(from + 1, to)
  }
  if (type === LEZER_NODE_IDS.HardBreak) {
    return ' '
  }
  if (type === LEZER_NODE_IDS.Wikilink || type === LEZER_NODE_IDS.WikiEmbed) {
    return renderWikiLink(text, element)
  }
  const link = insideLink || type === LEZER_NODE_IDS.Link || type === LEZER_NODE_IDS.Image
  return renderElements(text, children, from, to, link)
}

function renderWikiLink(text: string, element: InlineElement): string {
  const open = element.type === LEZER_NODE_IDS.WikiEmbed ? 3 : 2
  const inner = text.slice(element.from + open, element.to - 2)
  const pipe = inner.indexOf('|')
  const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim()
  const alias = pipe === -1 ? '' : inner.slice(pipe + 1).trim()
  return alias || target
}
