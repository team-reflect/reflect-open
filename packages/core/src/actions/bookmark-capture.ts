import { z } from 'zod'
import { parseNote } from '../markdown/extract'
import { parseFrontmatter, splitFrontmatter, upsertFrontmatter } from '../markdown/frontmatter'
import { sectionEnd, topLevelHeadings } from '../markdown/heading-blocks'
import { notePrivate } from '../privacy/checkers'
import { getBookmarkPostId, postIdSchema, type BookmarkEnvelope } from './bookmark-envelope'

const receiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    events: z.record(z.guid(), postIdSchema),
  })
  .strict()

/** A capture that needs manual recovery, not repeated background writes. */
export class BookmarkCaptureError extends Error {}

/** Append a post and its delivery receipt in the same daily-note revision. */
export function appendBookmark(source: string, envelope: BookmarkEnvelope): string {
  const split = splitFrontmatter(source)
  if (/^---[ \t]*\r?\n/.test(source) && split.raw === null)
    throw new BookmarkCaptureError('Unclosed daily note frontmatter')
  const metadata = parseFrontmatter(split.raw)
  if (metadata.warning) throw new BookmarkCaptureError('Invalid daily note frontmatter')
  const stored = metadata.data['reflectBookmarkReceipts']
  const result = receiptSchema.safeParse(
    stored === undefined ? { schemaVersion: 1, events: {} } : stored,
  )
  if (!result.success) throw new BookmarkCaptureError('Invalid bookmark receipts in daily note')
  const receipts = result.data
  if (envelope.id in receipts.events) {
    if (receipts.events[envelope.id] !== envelope.postId)
      throw new BookmarkCaptureError('Bookmark receipt ID conflict')
    return source
  }
  const parsed = parseNote({ path: '', source })
  if (!parsed.links.some((link) => getBookmarkPostId(link.href) === envelope.postId)) {
    const url = `https://x.com/i/status/${envelope.postId}`
    const markdown =
      envelope.presentation === 'embed' && !notePrivate(source)
        ? `![](${url})`
        : `[X post ${envelope.postId}](${url})`
    const headings = topLevelHeadings(parsed.headings)
    const heading = headings.find(
      (candidate) => candidate.level === 2 && candidate.text === 'X bookmarks',
    )
    const position = heading ? sectionEnd(headings, heading, source.length) : source.length
    const prefix = source.slice(0, position)
    let separator = ''
    if (prefix && !prefix.endsWith('\n\n')) separator = prefix.endsWith('\n') ? '\n' : '\n\n'
    const headingMarkdown = heading ? '' : '## X bookmarks\n\n'
    source = `${prefix}${separator}${headingMarkdown}${markdown}\n\n${source.slice(position)}`
  }
  return upsertFrontmatter(source, {
    reflectBookmarkReceipts: {
      schemaVersion: 1,
      events: { ...receipts.events, [envelope.id]: envelope.postId },
    },
  })
}
