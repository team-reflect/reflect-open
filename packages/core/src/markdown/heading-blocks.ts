import type { Heading } from './model'

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
