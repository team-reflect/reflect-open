import type { SyntaxNode } from '@meowdown/markdown'
import { splitFrontmatter } from './frontmatter'
import { parseBody } from './grammar'
import type { Heading } from './model'

function offsetBeforeLineEnding(source: string, offset: number): number {
  return source[offset - 1] === '\r' && source[offset] === '\n' ? offset - 1 : offset
}

function nearbyLineEnding(source: string, from: number, to: number): '\r\n' | '\n' {
  if (source.slice(from, to).includes('\r\n') || source.startsWith('\r\n', from)) {
    return '\r\n'
  }
  const previousNewline = source.lastIndexOf('\n', from - 1)
  return previousNewline > 0 && source[previousNewline - 1] === '\r' ? '\r\n' : '\n'
}

function listMarker(source: string, bodyOffset: number, list: SyntaxNode): string | null {
  let listItem = list.lastChild
  while (listItem !== null && listItem.name !== 'ListItem') {
    listItem = listItem.prevSibling
  }
  let marker = listItem?.firstChild ?? null
  while (marker !== null && marker.name !== 'ListMark') {
    marker = marker.nextSibling
  }
  if (marker === null) {
    return null
  }
  const value = source.slice(bodyOffset + marker.from, bodyOffset + marker.to)
  return value === '-' || value === '+' || value === '*' ? value : null
}

function withListMarker(item: string, marker: string | null): string {
  const trimmed = item.trim()
  if (!/^[-+*][ \t]+/.test(trimmed)) {
    throw new Error('a list item must start with -, +, or * followed by whitespace')
  }
  return marker === null ? trimmed : marker + trimmed.slice(1)
}

/**
 * Insert one unordered-list item into the leading list directly beneath a
 * top-level heading. Later prose, subheadings, and later lists are never
 * crossed. When the first block is not a bullet list, start a new list directly
 * beneath the heading.
 */
export function appendListItemAtHeading(source: string, target: Heading, item: string): string {
  const { body, bodyOffset } = splitFrontmatter(source)
  const targetBodyFrom = target.from - bodyOffset
  let targetBlock = parseBody(body).topNode.firstChild
  while (targetBlock !== null && targetBlock.from !== targetBodyFrom) {
    targetBlock = targetBlock.nextSibling
  }
  if (targetBlock === null) {
    throw new Error('a list item target must be a top-level heading')
  }

  const firstBlock = targetBlock.nextSibling
  const leadingList = firstBlock?.name === 'BulletList' ? firstBlock : null
  const anchorBodyOffset = leadingList?.to ?? target.to - bodyOffset
  const followingBlock = leadingList === null ? firstBlock : leadingList.nextSibling
  const tailBodyOffset = followingBlock?.from ?? body.length
  const anchor = offsetBeforeLineEnding(source, bodyOffset + anchorBodyOffset)
  const tail = bodyOffset + tailBodyOffset
  const lineEnding = nearbyLineEnding(source, anchor, tail)
  const normalizedItem = withListMarker(
    item,
    leadingList === null ? null : listMarker(source, bodyOffset, leadingList),
  )
  if (leadingList !== null) {
    const suffix = source.slice(anchor)
    return source.slice(0, anchor) + lineEnding + normalizedItem + (suffix || lineEnding)
  }

  const existingGap = source.slice(anchor, tail)
  let suffix: string = lineEnding
  if (followingBlock !== null) {
    suffix = existingGap.includes(lineEnding.repeat(2))
      ? existingGap
      : lineEnding.repeat(2)
  }
  return (
    source.slice(0, anchor) +
    lineEnding.repeat(2) +
    normalizedItem +
    suffix +
    source.slice(tail)
  )
}

/** Validate and trim an unordered-list item when creating a missing section. */
export function normalizeListItem(item: string): string {
  return withListMarker(item, null)
}
