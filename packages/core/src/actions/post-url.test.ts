import { describe, expect, it } from 'vitest'
import { isPostUrl, parsePostUrl, postPermalink, profileUrl } from './post-url'

describe('parsePostUrl', () => {
  it.each([
    ['https://x.com/jack/status/20', 'jack'],
    ['https://twitter.com/jack/status/20', 'jack'],
    ['https://www.x.com/jack/status/20?s=46&t=abc', 'jack'],
    ['https://mobile.twitter.com/jack/status/20', 'jack'],
    ['https://x.com/jack/status/20/photo/1', 'jack'],
    ['https://x.com/jack/status/20/video/1', 'jack'],
    ['http://x.com/jack/status/20#anchor', 'jack'],
  ])('canonicalizes %s', (url, handle) => {
    expect(parsePostUrl(url)).toEqual({
      provider: 'x',
      id: '20',
      handle,
      url: 'https://x.com/jack/status/20',
    })
  })

  it.each(['https://twitter.com/i/web/status/20', 'https://x.com/i/status/20'])(
    'keeps the handle-less form for %s',
    (url) => {
      expect(parsePostUrl(url)).toEqual({
        provider: 'x',
        id: '20',
        handle: null,
        url: 'https://x.com/i/status/20',
      })
    },
  )

  it.each([
    'https://x.com/jack',
    'https://x.com/i/bookmarks',
    'https://x.com/home',
    'https://x.com/jack/status/',
    'https://x.com/jack/status/not-a-number',
    'https://x.com/jack/likes/20',
    'https://x.com/@jack/status/20',
    'https://x.com.evil.com/jack/status/20',
    'https://example.com/jack/status/20',
    'ftp://x.com/jack/status/20',
    'not a url',
  ])('rejects %s', (url) => {
    expect(parsePostUrl(url)).toBeNull()
    expect(isPostUrl(url)).toBe(false)
  })
})

describe('postPermalink', () => {
  it('spells the canonical forms', () => {
    expect(postPermalink('20', 'jack')).toBe('https://x.com/jack/status/20')
    expect(postPermalink('20', null)).toBe('https://x.com/i/status/20')
    expect(profileUrl('jack')).toBe('https://x.com/jack')
  })
})
