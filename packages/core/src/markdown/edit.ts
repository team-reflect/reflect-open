import { appendListItemAtHeading, listItemBlock } from './append-list-item.ts'
import { appendHeadingSection } from './append-section.ts'
import { parseNote } from './extract.ts'
import { topLevelHeadings } from './heading-blocks.ts'
import { foldKey } from './keys.ts'
import type { Heading, WikiLink } from './model.ts'
import { normalizeWikiTarget } from './resolve.ts'
import { scanInlineWikiLinks } from './scan.ts'

export { appendBlock } from './append-section.ts'
export { appendListItem, type ListItemKind } from './append-list-item.ts'

/**
 * Source-level edit helpers (Plan 03). These splice the original string by node
 * position rather than re-serializing the document, so untouched bytes — and
 * thus sync diffs (Plan 12) — stay minimal. (Frontmatter edits live in
 * `frontmatter.ts`'s `upsertFrontmatter`.)
 */

/**
 * Schedule a task by setting its due date to `isoDate` (a `YYYY-MM-DD`), working
 * on the task's **content** — the markdown after the marker. A task's due date is
 * the first calendar-valid `[[YYYY-MM-DD]]` link inside it (the same rule the
 * projection reads), so this replaces that link's target when one exists, else
 * appends `[[isoDate]]` to the content. Returned content is fed back through
 * {@link editTaskLine}; the caller supplies a valid ISO date (the calendar only
 * yields real days).
 */
export function setTaskDueDate(content: string, isoDate: string): string {
  const existing = scanInlineWikiLinks(content).find(
    (link) => normalizeWikiTarget(link.target).date !== undefined,
  )
  if (existing !== undefined) {
    return content.slice(0, existing.from) + `[[${isoDate}]]` + content.slice(existing.to)
  }
  const trimmed = content.replace(/\s+$/, '')
  return trimmed.length > 0 ? `${trimmed} [[${isoDate}]]` : `[[${isoDate}]]`
}

/**
 * Unschedule a task: drop its first calendar-valid `[[YYYY-MM-DD]]` due-date link
 * from the content (collapsing the surrounding whitespace), or return the content
 * unchanged when it has no due date. The inverse of {@link setTaskDueDate}.
 */
export function clearTaskDueDate(content: string): string {
  const existing = scanInlineWikiLinks(content).find(
    (link) => normalizeWikiTarget(link.target).date !== undefined,
  )
  if (existing === undefined) {
    return content
  }
  const removed = content.slice(0, existing.from) + content.slice(existing.to)
  return removed.replaceAll(/[ \t]{2,}/g, ' ').trim()
}

/**
 * `[[…]]` has no escaping — strip the characters that would corrupt a link
 * before embedding untrusted text (a page title, a meeting name) in one.
 */
export function wikiLinkSafe(text: string): string {
  return text
    .replaceAll(/[[\]|\r\n]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

/**
 * Insert an unordered-list item into the list beneath the first matching
 * top-level heading. If the heading is missing, append a new H2 section.
 * `content` carries no bullet marker; see {@link appendListItemAtHeading}.
 */
export function appendListItemUnderHeading(
  source: string,
  heading: string,
  content: string,
): string {
  const headingKey = heading.trim().toLowerCase()
  const { headings } = parseNote({ path: '', source })
  const target = topLevelHeadings(headings).find(
    (candidate) => candidate.text.toLowerCase() === headingKey,
  )

  if (target === undefined) {
    return appendHeadingSection(source, heading, listItemBlock(content))
  }
  return appendListItemAtHeading(source, target, content)
}

/** The target when a heading consists entirely of one parsed wiki link. */
function linkedHeadingTarget(
  source: string,
  heading: Heading,
  wikiLinks: readonly WikiLink[],
): string | null {
  const raw = source.slice(heading.from, heading.to)
  const firstLine = raw.slice(0, !raw.includes('\n') ? raw.length : raw.indexOf('\n'))
  const content = firstLine
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/, '')
    .replace(/[ \t]+#+[ \t]*$/, '')
    .trim()
  const match = /^\[\[\s*([^\]|\r\n]+?)\s*(?:\|[^\]\r\n]*)?\]\]$/.exec(content)
  const textTarget = match?.[1]?.trim()
  if (textTarget === undefined || textTarget === '') {
    return null
  }
  const parsedLink = wikiLinks.find(
    (link) =>
      link.from >= heading.from &&
      link.to <= heading.to &&
      foldKey(link.target) === foldKey(textTarget),
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

function matchingBacklinkedHeading(
  source: string,
  headings: readonly Heading[],
  wikiLinks: readonly WikiLink[],
  titles: readonly string[],
): Heading | undefined {
  const matches = topLevelHeadings(headings).filter(
    (heading) =>
      heading.level === 2 &&
      titles.some((title) => headingMatchesBacklinkedTitle(source, heading, wikiLinks, title)),
  )
  return (
    matches.find((heading) => linkedHeadingTarget(source, heading, wikiLinks) !== null) ??
    matches[0]
  )
}

/**
 * Add the missing wiki link to an existing legacy `## Title` section heading.
 * Missing or already-linked sections are byte-identical no-ops.
 */
export function upgradeSectionHeadingBacklink(
  source: string,
  title: string,
  matchingTitles: readonly string[] = [],
): string {
  const safeTitle = wikiLinkSafe(title)
  if (safeTitle === '') {
    throw new Error('a backlinked heading needs a title')
  }
  const { headings, wikiLinks } = parseNote({ path: '', source })
  const target = matchingBacklinkedHeading(source, headings, wikiLinks, [
    safeTitle,
    ...matchingTitles,
  ])
  if (target === undefined || linkedHeadingTarget(source, target, wikiLinks) !== null) {
    return source
  }
  return (
    source.slice(0, target.from) +
    `${'#'.repeat(target.level)} [[${safeTitle}]]` +
    source.slice(target.to)
  )
}

/**
 * Insert one unordered-list item into the list beneath a backlinked H2.
 * Existing legacy plain headings are upgraded in place; a missing section is
 * appended as `## [[Title]]`. `content` carries no bullet marker; see
 * {@link appendListItemAtHeading}.
 */
export function appendListItemUnderBacklinkedHeading(
  source: string,
  title: string,
  content: string,
  matchingTitles: readonly string[] = [],
): string {
  const safeTitle = wikiLinkSafe(title)
  if (safeTitle === '') {
    throw new Error('a backlinked heading needs a title')
  }
  const linkedHeading = `[[${safeTitle}]]`
  const upgraded = upgradeSectionHeadingBacklink(source, safeTitle, matchingTitles)
  const { headings, wikiLinks } = parseNote({ path: '', source: upgraded })
  const target = matchingBacklinkedHeading(upgraded, headings, wikiLinks, [
    safeTitle,
    ...matchingTitles,
  ])

  if (target === undefined) {
    return appendHeadingSection(upgraded, linkedHeading, listItemBlock(content))
  }
  return appendListItemAtHeading(upgraded, target, content)
}
