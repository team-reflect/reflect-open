import { parseXPostId } from '@post-embed/schema'
import { parseNote } from '../markdown/extract'
import { sectionEnd, topLevelHeadings } from '../markdown/heading-blocks'
import type { XPostEnvelope } from './bookmark-envelope'

/** Append an X embed under its action section unless the note already links that post. */
export function appendXPost(source: string, envelope: XPostEnvelope): string {
  const sectionTitle = envelope.kind === 'x-like' ? 'X likes' : 'X bookmarks'
  const postId = envelope.data ? envelope.data.id : envelope.postId
  const parsed = parseNote({ path: '', source })
  if (parsed.links.some((link) => parseXPostId(link.href) === postId)) {
    return source
  }
  const line = `![](https://x.com/i/status/${postId})`
  const headings = topLevelHeadings(parsed.headings)
  const heading = headings.find(
    (candidate) => candidate.level === 2 && candidate.text === sectionTitle,
  )
  const position = heading ? sectionEnd(headings, heading, source.length) : source.length
  const prefix = source.slice(0, position)
  const suffix = source.slice(position)
  let separator = ''
  if (prefix && !prefix.endsWith('\n\n')) separator = prefix.endsWith('\n') ? '\n' : '\n\n'
  const block = heading ? `${line}\n` : `## ${sectionTitle}\n\n${line}\n`
  return `${prefix}${separator}${block}${suffix ? `\n${suffix}` : ''}`
}
