import type { SyntaxNode, Tree } from '@lezer/common'
import { parseFrontmatter, splitFrontmatter } from '../markdown/frontmatter'
import { parseBody } from '../markdown/grammar'
import { unescapeMarkdownText } from '../markdown/plain-text'
import { normalizeWikiTarget } from '../markdown/resolve'

/**
 * Block-level context extraction for the backlinks panel, ported from old
 * Reflect's `getBacklinkContextHtml`. Where {@link lineAt} returns only the
 * physical line around a link, this walks the parsed block structure and
 * returns the whole unit of meaning the mention sits in:
 *
 * - **Paragraph** — the whole paragraph (which may wrap across lines).
 * - **Heading** — the heading plus every following sibling block up to the
 *   next heading (of any level) or the end of the section's parent.
 * - **Title heading** — just the heading line. A deliberate divergence from
 *   old Reflect, where titles lived outside the document: in V2 the note's
 *   title *is* its first H1, so the section rule would inline the entire note
 *   into the panel for a mention that just says "this note is about you".
 *   Follows {@link parseNote}'s derivation exactly: a frontmatter `title:`
 *   owns the title, and then every H1 is an ordinary section heading.
 * - **Top-level list item** — the entire item including all of its nested
 *   children (sub-bullets, task lists), mentioning or not.
 * - **Nested list item** — the parent item's own text line for context, plus
 *   each sibling branch under that parent that also mentions the same target;
 *   branches that don't mention it are dropped. Only one ancestor level is
 *   climbed, exactly like old Reflect.
 *
 * The result is Markdown sliced from the source (full lines, dedented to the
 * context's own indentation) so nested structure survives rendering, and is
 * never truncated — old Reflect showed the full context and clamped the panel,
 * not the snippet.
 */

const HEADING_NODE_RE = /^(?:ATXHeading|SetextHeading)[1-6]$/
const H1_NODE_RE = /^(?:ATXHeading|SetextHeading)1$/

function isHeadingName(name: string): boolean {
  return HEADING_NODE_RE.test(name)
}

/** Leaf blocks that hold inline content (GFM turns a task item's paragraph into `Task`). */
function isTextblockName(name: string): boolean {
  return name === 'Paragraph' || name === 'Task'
}

function isListName(name: string): boolean {
  return name === 'BulletList' || name === 'OrderedList'
}

function selfOrAncestor(
  node: SyntaxNode | null,
  matches: (node: SyntaxNode) => boolean,
): SyntaxNode | null {
  for (let current = node; current; current = current.parent) {
    if (matches(current)) {
      return current
    }
  }
  return null
}

/** The normalized match key of a `[[…]]` node, or `null` for a blank target. */
function wikiTargetKeyOf(body: string, link: SyntaxNode): string | null {
  const inner = body.slice(link.from + 2, link.to - 2)
  const pipe = inner.indexOf('|')
  const target = unescapeMarkdownText((pipe === -1 ? inner : inner.slice(0, pipe)).trim())
  return target === '' ? null : normalizeWikiTarget(target).key
}

/** Does the textblock's inline content hold a wiki link with one of these match keys? */
function textblockMentions(body: string, block: SyntaxNode, keys: ReadonlySet<string>): boolean {
  for (let child = block.firstChild; child; child = child.nextSibling) {
    if (child.name === 'WikiLink') {
      const key = wikiTargetKeyOf(body, child)
      if (key !== null && keys.has(key)) {
        return true
      }
    } else if (textblockMentions(body, child, keys)) {
      return true // links nested in emphasis/strikethrough still count
    }
  }
  return false
}

/**
 * Does a candidate branch (a sibling list item or block under the parent item)
 * mention the target in its *direct* text blocks? Deeper descendants don't
 * qualify the branch — old Reflect's `nodeHasDirectBacklink` looked exactly one
 * block deep, and each mention deeper down produces its own context anyway.
 */
function branchMentions(body: string, branch: SyntaxNode, keys: ReadonlySet<string>): boolean {
  if (keys.size === 0) {
    return false
  }
  if (isTextblockName(branch.name)) {
    return textblockMentions(body, branch, keys)
  }
  for (let child = branch.firstChild; child; child = child.nextSibling) {
    if (isTextblockName(child.name) && textblockMentions(body, child, keys)) {
      return true
    }
  }
  return false
}

function lineStartAt(body: string, pos: number): number {
  return body.lastIndexOf('\n', Math.max(0, pos - 1)) + 1
}

function lineEndAt(body: string, pos: number): number {
  const next = body.indexOf('\n', pos)
  return next === -1 ? body.length : next
}

/**
 * Context text in line-structured form: `origins[i]` is the body offset of the
 * first character of `lines[i]` — the character the line starts with *after*
 * dedenting, so an offset within a snippet line maps back to the source by
 * plain addition. The tracked origins are what lets a snippet interaction (a
 * task checkbox click) write through to the exact source position.
 */
interface ContextLines {
  lines: string[]
  origins: number[]
  sourceLines: string[]
}

/** Drop trailing all-whitespace lines, then trailing whitespace of the last line. */
function trimTrailing(context: ContextLines): ContextLines {
  const { lines, origins, sourceLines } = context
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
    lines.pop()
    origins.pop()
    sourceLines.pop()
  }
  if (lines.length > 0) {
    lines[lines.length - 1] = lines[lines.length - 1]!.replace(/\s+$/, '')
  }
  return context
}

/**
 * The full lines covering `[from, to)`, with `prefix` stripped from every line
 * it leads. Deeper indentation stays relative, so a sliced list still renders
 * nested.
 */
function dedentedSlice(body: string, from: number, to: number, prefix: string): ContextLines {
  const start = lineStartAt(body, from)
  const end = to > from && body[to - 1] === '\n' ? to - 1 : to
  const lines: string[] = []
  const origins: number[] = []
  const sourceLines: string[] = []
  let lineStart = start
  for (const raw of body.slice(start, lineEndAt(body, end)).split('\n')) {
    const stripped = prefix !== '' && raw.startsWith(prefix)
    const line = stripped ? raw.slice(prefix.length) : raw
    lines.push(line)
    sourceLines.push(line)
    origins.push(stripped ? lineStart + prefix.length : lineStart)
    lineStart += raw.length + 1
  }
  return trimTrailing({ lines, origins, sourceLines })
}

/**
 * A block's full lines dedented by its own first-line prefix — the text before
 * `from` on its line: indentation, or `> ` inside a blockquote.
 */
function dedentedBlockAt(body: string, from: number, to: number): ContextLines {
  return dedentedSlice(body, from, to, body.slice(lineStartAt(body, from), from))
}

/** The heading's section: itself plus siblings until the next heading of any level. */
function headingSectionEnd(heading: SyntaxNode): number {
  let end = heading.to
  for (let sibling = heading.nextSibling; sibling; sibling = sibling.nextSibling) {
    if (isHeadingName(sibling.name)) {
      break
    }
    end = sibling.to
  }
  return end
}

/** Does the heading's text line carry anything beyond ATX `#` marks? */
function headingHasText(body: string, heading: SyntaxNode): boolean {
  const firstLine = body.slice(heading.from, lineEndAt(body, heading.from))
  return (
    firstLine
      .replace(/^#{1,6}[ \t]*/, '')
      .replace(/[ \t]*#*[ \t]*$/, '')
      .trim() !== ''
  )
}

/**
 * Is this heading the note's title — the document's first non-empty top-level
 * H1, the same heading {@link parseNote}'s title derivation picks? When
 * frontmatter authors a `title:`, that derivation never promotes an H1, so no
 * heading is the title and every H1 keeps the section rule.
 */
function isTitleHeading(body: string, heading: SyntaxNode, frontmatterTitled: boolean): boolean {
  if (frontmatterTitled) {
    return false
  }
  if (!H1_NODE_RE.test(heading.name) || heading.parent?.name !== 'Document') {
    return false
  }
  for (let child = heading.parent.firstChild; child; child = child.nextSibling) {
    if (H1_NODE_RE.test(child.name) && headingHasText(body, child)) {
      return child.from === heading.from
    }
  }
  return false
}

/** The item's first block child when it is a text block (its own bullet line). */
function leadTextblock(item: SyntaxNode): SyntaxNode | null {
  for (let child = item.firstChild; child; child = child.nextSibling) {
    if (child.name === 'ListMark' || child.name === 'TaskMarker') {
      continue
    }
    return isTextblockName(child.name) ? child : null
  }
  return null
}

function containsPos(node: SyntaxNode, pos: number): boolean {
  return node.from <= pos && pos < node.to
}

/**
 * Context for a mention inside a list item, per old Reflect's rules: a
 * top-level item yields its whole subtree; a nested item yields the parent
 * item's own line plus the branches under it that mention the same target
 * (always including the branch the mention itself sits in).
 */
function listItemContext(
  body: string,
  item: SyntaxNode,
  targetKeys: ReadonlySet<string>,
  bodyPos: number,
): ContextLines {
  const parentItem = selfOrAncestor(item.parent, (node) => node.name === 'ListItem')
  const lead = parentItem ? leadTextblock(parentItem) : null
  if (!parentItem || !lead) {
    return dedentedBlockAt(body, item.from, item.to)
  }

  const indent = body.slice(lineStartAt(body, parentItem.from), parentItem.from)
  const pieces: ContextLines[] = [dedentedBlockAt(body, parentItem.from, lead.to)]
  for (let child = lead.nextSibling; child; child = child.nextSibling) {
    const branches = isListName(child.name) ? child.getChildren('ListItem') : [child]
    for (const branch of branches) {
      if (branchMentions(body, branch, targetKeys) || containsPos(branch, bodyPos)) {
        pieces.push(dedentedSlice(body, branch.from, branch.to, indent))
      }
    }
  }
  return {
    lines: pieces.flatMap((piece) => piece.lines),
    origins: pieces.flatMap((piece) => piece.origins),
    sourceLines: pieces.flatMap((piece) => piece.sourceLines),
  }
}

/**
 * A note's source prepared for repeated {@link blockContextAt} calls: the
 * frontmatter carved off once and the body parsed once. The backlinks query
 * extracts a context per *mention*, and a well-linked source contributes many
 * mentions — re-parsing per mention would make the panel's cost scale with
 * link count instead of source count.
 */
export interface BlockContextSource {
  /** Markdown body with the frontmatter carved off. */
  readonly body: string
  /** Character offset of `body` within the original file. */
  readonly bodyOffset: number
  /** `body` parsed with the canonical Reflect grammar. */
  readonly tree: Tree
  /** Frontmatter authors a `title:`, so no H1 is the note's title. */
  readonly frontmatterTitled: boolean
}

/** Parse a note's full source once for repeated {@link blockContextAt} calls. */
export function prepareBlockContext(content: string): BlockContextSource {
  const { raw, body, bodyOffset } = splitFrontmatter(content)
  const title = (parseFrontmatter(raw).data as Record<string, unknown>)['title']
  const frontmatterTitled = typeof title === 'string' && title.trim() !== ''
  return { body, bodyOffset, tree: parseBody(body), frontmatterTitled }
}

/**
 * A block context with its write-back coordinates: the snippet Markdown plus,
 * per snippet line, the whole-file offset of the line's first character (the
 * dedent already accounted for — see {@link ContextLines}). Interactions
 * inside a rendered snippet map back to the source by line + column.
 */
export interface BlockContextLines {
  /** The snippet Markdown, exactly what {@link blockContextAt} returns. */
  text: string
  /** Whole-file offset of each snippet line's first character. */
  lineOrigins: number[]
  /**
   * Each snippet line's exact source text from `lineOrigins[i]` to the physical
   * line end, before display-only trailing whitespace trimming.
   */
  lineSourceTexts: string[]
}

function contextLinesAt(
  source: string | BlockContextSource,
  pos: number,
  targetKeys?: ReadonlySet<string>,
): { context: ContextLines; bodyOffset: number } {
  const { body, bodyOffset, tree, frontmatterTitled } =
    typeof source === 'string' ? prepareBlockContext(source) : source
  const bodyPos = Math.max(0, Math.min(pos - bodyOffset, body.length))
  const leaf: SyntaxNode = tree.resolveInner(bodyPos, 1)

  const link = selfOrAncestor(leaf, (node) => node.name === 'WikiLink')
  const posKey = link ? wikiTargetKeyOf(body, link) : null
  const keys = new Set(targetKeys)
  if (posKey !== null) {
    keys.add(posKey) // a stale index entry still anchors its own branch
  }

  const heading = selfOrAncestor(leaf, (node) => isHeadingName(node.name))
  if (heading) {
    const end = isTitleHeading(body, heading, frontmatterTitled)
      ? heading.to
      : headingSectionEnd(heading)
    return { context: dedentedBlockAt(body, heading.from, end), bodyOffset }
  }

  const item = selfOrAncestor(leaf, (node) => node.name === 'ListItem')
  if (item) {
    return { context: listItemContext(body, item, keys, bodyPos), bodyOffset }
  }

  const block = selfOrAncestor(leaf, (node) => isTextblockName(node.name))
  if (block) {
    return { context: dedentedBlockAt(body, block.from, block.to), bodyOffset }
  }

  // Not inside a text block: a table cell, or an offset drifted into the gap
  // between blocks. Use the nearest top-level block, else the bare line.
  const top = selfOrAncestor(leaf, (node) => node.parent?.name === 'Document')
  if (top) {
    return { context: dedentedBlockAt(body, top.from, top.to), bodyOffset }
  }
  const lineStart = lineStartAt(body, bodyPos)
  const raw = body.slice(lineStart, lineEndAt(body, bodyPos))
  const leading = raw.length - raw.trimStart().length
  return {
    context: { lines: [raw.trim()], origins: [lineStart + leading], sourceLines: [raw.slice(leading)] },
    bodyOffset,
  }
}

/**
 * The Markdown block context around the link at whole-file offset `pos` (the
 * index's `pos_from`, frontmatter offset included) — see the module doc for
 * the shape per mention location. Accepts either raw source (parsed on the
 * spot) or a {@link prepareBlockContext} handle when extracting several
 * contexts from one note. Falls back to the physical line when the offset has
 * drifted out of any block (the source changed between the index write and
 * this read).
 *
 * `targetKeys` is every match key that resolves to the target note (title,
 * aliases, daily date — the `note_keys` view). Sibling branches co-group when
 * they mention the target under *any* spelling, the way old Reflect compared
 * resolved note ids; without it, matching falls back to the exact spelling of
 * the link at `pos`.
 */
export function blockContextAt(
  source: string | BlockContextSource,
  pos: number,
  targetKeys?: ReadonlySet<string>,
): string {
  return contextLinesAt(source, pos, targetKeys).context.lines.join('\n')
}

/**
 * {@link blockContextAt} plus each snippet line's whole-file origin, for
 * mapping an interaction inside the rendered snippet (a task checkbox click)
 * back to the exact source offset it came from. Origins are as of this read;
 * a later edit can drift them, which the task toggle's staleness guard
 * ({@link toggleTaskMarker}) turns into a refusal rather than a wrong write.
 */
export function blockContextLinesAt(
  source: string | BlockContextSource,
  pos: number,
  targetKeys?: ReadonlySet<string>,
): BlockContextLines {
  const { context, bodyOffset } = contextLinesAt(source, pos, targetKeys)
  return {
    text: context.lines.join('\n'),
    lineOrigins: context.origins.map((origin) => origin + bodyOffset),
    lineSourceTexts: context.sourceLines,
  }
}
