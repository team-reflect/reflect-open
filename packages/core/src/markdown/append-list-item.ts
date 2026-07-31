import type { SyntaxNode } from '@meowdown/markdown'
import { splitFrontmatter } from './frontmatter'
import { parseBody } from './grammar'
import { lineEndingAt, offsetBeforeLineEnding } from './line-endings'
import type { Heading } from './model'
import { headingLevelOf, isBulletList, isListItem, isListMark } from './node-types'

/** The bullet a new list is born with when the section has none to copy. */
const DEFAULT_LIST_MARK = '-'

/** The top-level block that starts at `offset`, or `null`. */
function blockStartingAt(root: SyntaxNode, offset: number): SyntaxNode | null {
  for (let block = root.firstChild; block !== null; block = block.nextSibling) {
    if (block.from === offset) {
      return block
    }
  }
  return null
}

/**
 * The list an automatic entry belongs in: the first top-level bullet list
 * between `heading` and the next heading of any level. Stopping at *any*
 * heading keeps an entry out of a subsection the user wrote; taking the first
 * such list — rather than only a list flush against the heading — keeps one
 * category's entries in one list even when the section opens with prose.
 */
function sectionList(heading: SyntaxNode): SyntaxNode | null {
  for (let block = heading.nextSibling; block !== null; block = block.nextSibling) {
    if (headingLevelOf(block) !== null) {
      return null
    }
    if (isBulletList(block)) {
      return block
    }
  }
  return null
}

/** The `-`, `+` or `*` an existing list is written with. */
function listMark(source: string, bodyOffset: number, list: SyntaxNode): string {
  const item = list.lastChild
  const mark = item !== null && isListItem(item) ? item.firstChild : null
  if (mark === null || !isListMark(mark)) {
    return DEFAULT_LIST_MARK
  }
  const value = source.slice(bodyOffset + mark.from, bodyOffset + mark.to)
  // An ordered marker can't reach here, but a `ListMark` is the only node whose
  // text is the bullet, so guard the slice rather than trust the node alone.
  return value === '-' || value === '+' || value === '*' ? value : DEFAULT_LIST_MARK
}

/**
 * Insert `content` as one unordered-list item in the section under `target`.
 * It joins the section's first bullet list, or starts one directly beneath the
 * heading when the section has none. Later prose, subheadings, and lists in
 * other sections are never crossed, and an existing list keeps its own bullet
 * character (switching it would split the list in two).
 *
 * `content` is the item's text without a bullet marker: the marker belongs to
 * the list being extended, not to the caller.
 */
export function appendListItemAtHeading(source: string, target: Heading, content: string): string {
  const { body, bodyOffset } = splitFrontmatter(source)
  const heading = blockStartingAt(parseBody(body).topNode, target.from - bodyOffset)
  if (heading === null || headingLevelOf(heading) === null) {
    throw new Error('a list item target must be a top-level heading')
  }

  const list = sectionList(heading)
  const following = list === null ? heading.nextSibling : list.nextSibling
  const anchor = offsetBeforeLineEnding(source, bodyOffset + (list?.to ?? heading.to))
  const tail = bodyOffset + (following?.from ?? body.length)
  const lineEnding = lineEndingAt(source, anchor)
  const item = `${list === null ? DEFAULT_LIST_MARK : listMark(source, bodyOffset, list)} ${content.trim()}`

  if (list !== null) {
    const suffix = source.slice(anchor)
    return source.slice(0, anchor) + lineEnding + item + (suffix || lineEnding)
  }

  // Starting the list: reuse the gap that already followed the heading so the
  // blank lines the author left (meowdown renders each as an empty paragraph)
  // end up below the new item instead of being collapsed away.
  const existingGap = source.slice(anchor, tail)
  const suffix =
    following === null
      ? lineEnding
      : existingGap.includes(lineEnding.repeat(2))
        ? existingGap
        : lineEnding.repeat(2)
  return source.slice(0, anchor) + lineEnding.repeat(2) + item + suffix + source.slice(tail)
}

/** The same item, as the whole body of a section that does not exist yet. */
export function listItemBlock(content: string): string {
  return `${DEFAULT_LIST_MARK} ${content.trim()}`
}
