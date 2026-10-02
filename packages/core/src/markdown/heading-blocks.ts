import type { SyntaxNode } from '@meowdown/markdown'
import { foldKey } from './keys.ts'
import type { Heading, Span, WikiLink } from './model.ts'
import { isHeaderMark } from './node-types.ts'

/** Authored heading content, excluding syntax marks, in original-file coordinates. */
export function headingContentSpan(node: SyntaxNode, bodyOffset: number): Span {
  const first = node.firstChild
  const last = node.lastChild
  const from =
    first !== null && isHeaderMark(first) && first.from === node.from ? first.to : node.from
  const to = last !== null && isHeaderMark(last) && last.from >= from ? last.from : node.to
  return { from: from + bodyOffset, to: to + bodyOffset }
}

/**
 * The headings that open a section: those `parseNote` saw as direct blocks of
 * the document. A `## Meetings` nested in a blockquote or a list item is quoted
 * prose, so it must neither receive an automatic entry nor cut a real section
 * short.
 */
export function topLevelHeadings(headings: readonly Heading[]): readonly Heading[] {
  return headings.filter((heading) => heading.topLevel)
}

/** End offset for `target` within an ordered set of top-level headings. */
export function sectionEnd(
  headings: readonly Heading[],
  target: Heading,
  sourceLength: number,
): number {
  return (
    headings.find((heading) => heading.from > target.from && heading.level <= target.level)?.from ??
    sourceLength
  )
}

/** The target when a heading consists entirely of one parsed wiki link. */
export function linkedHeadingTarget(
  source: string,
  heading: Heading,
  wikiLinks: readonly WikiLink[],
): string | null {
  const { content } = heading
  const parsedLink = wikiLinks.find(
    (link) =>
      link.target !== '' &&
      link.from >= content.from &&
      link.to <= content.to &&
      source.slice(content.from, link.from).trim() === '' &&
      source.slice(link.to, content.to).trim() === '',
  )
  return parsedLink?.target ?? null
}

/**
 * Whether `heading` names `title` either as a linked heading (`## [[Links]]`)
 * or as the legacy plain form (`## Links`). A linked heading's target, rather
 * than its display alias, identifies the section.
 */
export function headingMatchesBacklinkedTitle(
  source: string,
  heading: Heading,
  wikiLinks: readonly WikiLink[],
  title: string,
): boolean {
  return foldKey(linkedHeadingTarget(source, heading, wikiLinks) ?? heading.text) === foldKey(title)
}
