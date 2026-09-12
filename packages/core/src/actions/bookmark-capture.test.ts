import { describe, expect, it } from 'vitest'
import { appendBookmark } from './bookmark-capture'
import { getBookmarkPostId, type BookmarkEnvelope } from './bookmark-envelope'
import { inboxEnvelopeSchema } from './capture-envelope'
import { parseNote } from '../markdown/extract'

const capture: BookmarkEnvelope = {
  version: 2,
  kind: 'x-bookmark',
  id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  source: 'extension',
  postId: '20',
  capturedAt: '2026-09-09T04:00:00Z',
}

describe('appendBookmark', () => {
  it('keeps frontmatter and prose while adding the section', () => {
    const source = '---\nprivate: true\n---\nMy unfinished thought\n'
    expect(appendBookmark(source, capture)).toBe(
      '---\nprivate: true\n---\nMy unfinished thought\n\n## X bookmarks\n\n![](https://x.com/i/status/20)\n',
    )
  })
  it('replays without duplicating and respects a deleted entry', () => {
    const saved = appendBookmark('', capture)
    expect(saved).toBe('## X bookmarks\n\n![](https://x.com/i/status/20)\n')
    expect(appendBookmark(saved, capture)).toBe(saved)
    expect(appendBookmark(saved, { ...capture, id: '7c9e6679-7425-40de-944b-e07fc1f90ae8' })).toBe(
      saved,
    )
  })
  it('deduplicates URL aliases, but ignores examples inside code fences', () => {
    const fenced = '```md\n![](https://x.com/i/status/20)\n```\n'
    expect(parseNote({ path: '', source: appendBookmark(fenced, capture) }).links).toHaveLength(1)
    const alias = '[source](https://twitter.com/jack/status/20?s=1)\n'
    expect(appendBookmark(alias, capture)).toBe(alias)
  })
  it('appends ten posts to one section and preserves later sections', () => {
    let source = '## X bookmarks\n\nMy note\n\n## Later\nKeep this\n'
    for (let index = 0; index < 10; index++) {
      source = appendBookmark(source, {
        ...capture,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        postId: String(index + 1),
      })
    }
    expect(parseNote({ path: '', source }).links).toHaveLength(10)
    expect(source).toContain('My note\n\n![](https://x.com/i/status/1)\n')
    expect(source.endsWith('![](https://x.com/i/status/10)\n\n## Later\nKeep this\n')).toBe(true)
  })
})

it('never falls back to the v1 link parser for an unknown kind or version', () => {
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
