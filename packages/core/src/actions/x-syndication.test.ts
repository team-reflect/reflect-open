import { describe, expect, it } from 'vitest'
import { parseXText } from './x-syndication'
import { xPostId, xPostURL } from './x-post'

describe('X post text', () => {
  it.each([
    'https://x.com/example/status/123?ref=timeline',
    'https://twitter.com/i/web/status/123',
    'https://mobile.twitter.com/example/status/123/photo/1',
    'https://www.x.com/i/status/123/video/2',
  ])('canonicalizes %s', (url) => {
    expect(xPostId(url)).toBe('123')
    expect(xPostURL('123')).toBe('https://x.com/i/status/123')
  })
  it.each([
    'https://x.com/home',
    'https://x.com.evil.com/i/status/123',
    'https://evil.com/x.com/i/status/123',
    'https://x.com/i/status/0',
    'https://x.com/i/status/123/other',
    'https://user@x.com/i/status/123',
    'file://x.com/i/status/123',
  ])('rejects %s', (url) => expect(xPostId(url)).toBeNull())
  it('uses code-point ranges before expanding URLs and decoding entities', () => {
    expect(
      parseXText(
        {
          id_str: '123',
          text: 'A😀 &amp; https://t.co/abcZ',
          display_text_range: [1, 25],
          entities: { urls: [{ url: 'https://t.co/abc', expanded_url: 'https://example.com/$&' }] },
        },
        '123',
      ),
    ).toMatchObject({ text: '😀 & https://example.com/$&', truncated: false })
  })
  it('marks long posts as previews and ignores nested media and quotes', () => {
    expect(
      parseXText(
        {
          id_str: '123',
          text: 'Preview',
          note_tweet: {},
          quoted_tweet: { text: 'Quote' },
          mediaDetails: [{ media_url_https: 'https://example.com/image' }],
        },
        '123',
      ),
    ).toEqual({ text: 'Preview', truncated: true })
  })
  it('limits by code point and marks invalid ranges as previews', () => {
    const post = parseXText(
      { id_str: '123', text: '😀'.repeat(20_001), display_text_range: [3, 1] },
      '123',
    )
    expect(post?.text).toBe('😀'.repeat(20_000))
    expect(post?.truncated).toBe(true)
  })
  it.each([{}, { id_str: '123', text: '' }, { id_str: '456', text: 'wrong post' }])(
    'has no public text for %j',
    (value) => {
      expect(parseXText(value, '123')).toBeNull()
    },
  )
})
