import { renderInlineText } from './inline-text.ts'
import { foldKey } from './keys.ts'
import type { Heading, WikiLink } from './model.ts'

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

/**
 * Whether a heading names one of `titles`, by the same rule the AST writer
 * (`appendListItem`) files entries by: the text it renders as, or the target
 * of a wiki link in it (`## [[Links|Saved links]]` is the Links section).
 */
export function headingNamesSection(
  heading: Heading,
  wikiLinks: readonly WikiLink[],
  titles: readonly string[],
): boolean {
  const keys = titles.map((title) => foldKey(title))
  return (
    keys.includes(foldKey(renderInlineText(heading.text))) ||
    wikiLinks.some(
      (link) =>
        link.from >= heading.from && link.to <= heading.to && keys.includes(foldKey(link.target)),
    )
  )
}
