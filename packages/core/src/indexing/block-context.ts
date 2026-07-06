import type { SyntaxNode, Tree } from '@lezer/common'
import { splitFrontmatter } from '../markdown/frontmatter'
import { parseBody } from '../markdown/grammar'
import { unescapeMarkdownText } from '../markdown/plain-text'
import { normalizeWikiTarget } from '../markdown/resolve'
import { lineAt } from './snippet'

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
 * The full lines covering `[from, to)`, with `prefix` stripped from every line
 * it leads. Deeper indentation stays relative, so a sliced list still renders
 * nested.
 */
function dedentedSlice(body: string, from: number, to: number, prefix: string): string {
  const start = lineStartAt(body, from)
  const end = to > from && body[to - 1] === '\n' ? to - 1 : to
  const lines = body.slice(start, lineEndAt(body, end)).split('\n')
  const dedented = lines.map((line) =>
    prefix !== '' && line.startsWith(prefix) ? line.slice(prefix.length) : line,
  )
  return dedented.join('\n').trimEnd()
}

/**
 * A block's full lines dedented by its own first-line prefix — the text before
 * `from` on its line: indentation, or `> ` inside a blockquote.
 */
function dedentedBlockAt(body: string, from: number, to: number): string {
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
 * H1, the same heading {@link parseNote}'s title derivation picks?
 */
function isTitleHeading(body: string, heading: SyntaxNode): boolean {
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
): string {
  const parentItem = selfOrAncestor(item.parent, (node) => node.name === 'ListItem')
  const lead = parentItem ? leadTextblock(parentItem) : null
  if (!parentItem || !lead) {
    return dedentedBlockAt(body, item.from, item.to)
  }

  const indent = body.slice(lineStartAt(body, parentItem.from), parentItem.from)
  const pieces: string[] = [dedentedBlockAt(body, parentItem.from, lead.to)]
  for (let child = lead.nextSibling; child; child = child.nextSibling) {
    const branches = isListName(child.name) ? child.getChildren('ListItem') : [child]
    for (const branch of branches) {
      if (branchMentions(body, branch, targetKeys) || containsPos(branch, bodyPos)) {
        pieces.push(dedentedSlice(body, branch.from, branch.to, indent))
      }
    }
  }
  return pieces.join('\n')
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
}

/** Parse a note's full source once for repeated {@link blockContextAt} calls. */
export function prepareBlockContext(content: string): BlockContextSource {
  const { body, bodyOffset } = splitFrontmatter(content)
  return { body, bodyOffset, tree: parseBody(body) }
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
  const { body, bodyOffset, tree } =
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
    const end = isTitleHeading(body, heading) ? heading.to : headingSectionEnd(heading)
    return dedentedBlockAt(body, heading.from, end)
  }

  const item = selfOrAncestor(leaf, (node) => node.name === 'ListItem')
  if (item) {
    return listItemContext(body, item, keys, bodyPos)
  }

  const block = selfOrAncestor(leaf, (node) => isTextblockName(node.name))
  if (block) {
    return dedentedBlockAt(body, block.from, block.to)
  }

  // Not inside a text block: a table cell, or an offset drifted into the gap
  // between blocks. Use the nearest top-level block, else the bare line.
  const top = selfOrAncestor(leaf, (node) => node.parent?.name === 'Document')
  if (top) {
    return dedentedBlockAt(body, top.from, top.to)
  }
  return lineAt(body, bodyPos)
}
