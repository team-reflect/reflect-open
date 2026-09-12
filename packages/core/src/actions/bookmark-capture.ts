import { parseNote } from '../markdown/extract'
import { sectionEnd, topLevelHeadings } from '../markdown/heading-blocks'
import { getBookmarkPostId, type BookmarkEnvelope } from './bookmark-envelope'

const SECTION_TITLE = 'X bookmarks'

/**
 * Append a bookmark link under the daily note's `## X bookmarks` section. A
 * post already linked anywhere in the note is left alone, so a replayed spool
 * never adds a second entry.
 */
export function appendBookmark(source: string, envelope: BookmarkEnvelope): string {
  const parsed = parseNote({ path: '', source })
  if (parsed.links.some((link) => getBookmarkPostId(link.href) === envelope.postId)) {
    return source
  }
  const line = `[X post ${envelope.postId}](https://x.com/i/status/${envelope.postId})`
  const headings = topLevelHeadings(parsed.headings)
  const heading = headings.find(
    (candidate) => candidate.level === 2 && candidate.text === SECTION_TITLE,
  )
  const position = heading ? sectionEnd(headings, heading, source.length) : source.length
  const prefix = source.slice(0, position)
  const suffix = source.slice(position)
  let separator = ''
  if (prefix && !prefix.endsWith('\n\n')) separator = prefix.endsWith('\n') ? '\n' : '\n\n'
  const block = heading ? `${line}\n` : `## ${SECTION_TITLE}\n\n${line}\n`
  return `${prefix}${separator}${block}${suffix ? `\n${suffix}` : ''}`
}
