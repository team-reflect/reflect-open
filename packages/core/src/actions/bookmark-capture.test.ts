import { describe, expect, it } from 'vitest'
import { appendBookmark } from './bookmark-capture'
import {
  bookmarkEnvelopeSchema,
  getBookmarkPostId,
  type BookmarkEnvelope,
} from './bookmark-envelope'
import { inboxEnvelopeSchema } from './capture-envelope'
import { parseNote } from '../markdown/extract'
import { parseFrontmatter, splitFrontmatter } from '../markdown/frontmatter'

const capture: BookmarkEnvelope = {
  version: 2,
  kind: 'x-bookmark',
  id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  source: 'extension',
  postId: '20',
  capturedAt: '2026-09-09T04:00:00Z',
  captureDate: '2026-09-09',
  targetGraphId: 'a'.repeat(64),
  evidence: 'request-intent',
  presentation: 'embed',
}

describe('bookmark daily source', () => {
  it('keeps edits and privacy while writing a receipt and link together', () => {
    const source = '---\nprivate: true\naliases: [Journal]\n---\nMy unfinished thought\n'
    const saved = appendBookmark(source, capture)
    expect(saved).toContain('My unfinished thought')
    expect(saved).toContain('[X post 20](https://x.com/i/status/20)')
    expect(saved).not.toContain('![]')
    expect(parseFrontmatter(splitFrontmatter(saved).raw).data.private).toBe(true)
    expect(appendBookmark(saved, capture)).toBe(saved)
  })
  it('replays one event 100 times without duplicating and respects a deleted card', () => {
    let source = appendBookmark('', capture)
    const saved = source
    for (let index = 0; index < 100; index++) source = appendBookmark(source, capture)
    expect(source).toBe(saved)
    source = source.replace('![](https://x.com/i/status/20)', 'My annotation')
    expect(appendBookmark(source, capture)).toBe(source)
  })
  it('deduplicates URL aliases, but ignores examples inside code fences', () => {
    const source = '```md\n![](https://x.com/i/status/20)\n```\n'
    const saved = appendBookmark(source, capture)
    expect(parseNote({ path: '', source: saved }).links).toHaveLength(1)
    const alias = '[source](https://twitter.com/jack/status/20?s=1)\n'
    expect(appendBookmark(alias, capture)).not.toContain('## X bookmarks')
  })
  it('appends ten posts to one source and preserves later sections', () => {
    let source = '## X bookmarks\n\nMy note\n\n## Later\nKeep this\n'
    for (let index = 0; index < 10; index++) {
      source = appendBookmark(source, {
        ...capture,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        postId: String(index + 1),
      })
    }
    expect(parseNote({ path: '', source }).links).toHaveLength(10)
    expect(source).toContain('My note')
    expect(source.endsWith('## Later\nKeep this\n')).toBe(true)
  })
  it('refuses malformed receipts and invalid dates rather than resetting metadata', () => {
    expect(() =>
      appendBookmark('---\nreflectBookmarkReceipts: broken\n---\nUser content', capture),
    ).toThrow()
    expect(
      bookmarkEnvelopeSchema.safeParse({ ...capture, captureDate: '2026-02-31' }).success,
    ).toBe(false)
    expect(
      inboxEnvelopeSchema.safeParse({
        ...capture,
        version: 99,
        url: 'https://example.com',
        title: 'fallback',
      }).success,
    ).toBe(false)
    expect(
      inboxEnvelopeSchema.safeParse({
        version: 1,
        kind: 'future',
        id: capture.id,
        capturedAt: capture.capturedAt,
        source: 'extension',
        url: 'https://example.com',
        title: 'fallback',
      }).success,
    ).toBe(false)
  })
  it('accepts canonical IDs and rejects misleading permalink hosts', () => {
    expect(getBookmarkPostId('https://x.com/i/status/20')).toBe('20')
    expect(getBookmarkPostId('https://x.com.evil.test/i/status/20')).toBeUndefined()
    expect(getBookmarkPostId('https://x.com/home')).toBeUndefined()
  })
})
