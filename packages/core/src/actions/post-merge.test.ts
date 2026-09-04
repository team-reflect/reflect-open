import { describe, expect, it } from 'vitest'
import type { CapturedPost } from './capture-envelope'
import { mergePost } from './post-merge'

const PAGE: CapturedPost = {
  provider: 'x',
  id: '20',
  trigger: 'bookmark',
  author: { name: 'jack (page)', handle: 'jack' },
  text: 'just setting up my twttr',
  postedAt: '2006-03-21T00:00:00.000Z',
  media: [{ kind: 'image', url: 'https://pbs.twimg.com/media/a.jpg?name=large' }],
}

const REMOTE: CapturedPost = {
  provider: 'x',
  id: '20',
  trigger: 'bookmark',
  author: { name: 'jack', handle: 'jack' },
  text: 'just setting up my twttr',
  postedAt: '2006-03-21T20:50:14.000Z',
  media: [{ kind: 'image', url: 'https://pbs.twimg.com/media/a.jpg?name=large', alt: 'twttr' }],
  quoted: { id: '1', url: 'https://x.com/a/status/1', author: { name: 'A', handle: 'a' } },
}

describe('mergePost', () => {
  it('returns the page fields when the endpoint had nothing', () => {
    expect(mergePost(PAGE, null)).toEqual(PAGE)
  })

  it('takes structure from the endpoint and keeps the page identity', () => {
    expect(mergePost({ ...PAGE, trigger: 'like' }, REMOTE)).toEqual({ ...REMOTE, trigger: 'like' })
  })

  it('fills endpoint gaps from the page', () => {
    const sparseRemote: CapturedPost = { provider: 'x', id: '20', trigger: 'manual', text: 'hi' }
    expect(mergePost(PAGE, sparseRemote)).toEqual({ ...PAGE, text: 'hi' })
  })

  it('prefers the page text when the endpoint only has a long-form preview', () => {
    const merged = mergePost(
      { ...PAGE, text: 'the whole long post', truncated: false },
      { ...REMOTE, text: 'the whole', truncated: true },
    )
    expect(merged.text).toBe('the whole long post')
    expect(merged.truncated).toBeUndefined()
  })

  it('keeps the longer prefix, still truncated, when neither side is complete', () => {
    const merged = mergePost(
      { ...PAGE, text: 'the whole long', truncated: true },
      { ...REMOTE, text: 'the whole', truncated: true },
    )
    expect(merged.text).toBe('the whole long')
    expect(merged.truncated).toBe(true)

    const remoteLonger = mergePost(
      { ...PAGE, text: 'the', truncated: true },
      { ...REMOTE, text: 'the whole', truncated: true },
    )
    expect(remoteLonger.text).toBe('the whole')
    expect(remoteLonger.truncated).toBe(true)
  })

  it('takes the endpoint text over a truncated page text', () => {
    const merged = mergePost({ ...PAGE, text: 'just', truncated: true }, REMOTE)
    expect(merged.text).toBe('just setting up my twttr')
    expect(merged.truncated).toBeUndefined()
  })

  it('treats blank text as absent', () => {
    const merged = mergePost({ ...PAGE, text: '   ' }, { ...REMOTE, text: undefined })
    expect(merged.text).toBeUndefined()
    expect(merged.truncated).toBeUndefined()
  })
})
