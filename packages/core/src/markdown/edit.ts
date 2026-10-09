import { normalizeWikiTarget } from './resolve.ts'
import { scanInlineWikiLinks } from './scan.ts'

export { appendBlock } from './append-section.ts'

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
