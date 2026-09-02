import { describe, expect, it } from 'vitest'
import type { CaptureEnvelope } from './capture-envelope'
import { postCaptureOf } from './post-capture'

const ENVELOPE: CaptureEnvelope = {
  version: 1,
  id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  url: 'https://example.com/article',
  title: 'An article',
  capturedAt: '2026-09-02T10:15:22.317Z',
  source: 'extension',
}

describe('postCaptureOf', () => {
  it('leaves a non-post link alone', () => {
    expect(postCaptureOf(ENVELOPE)).toEqual({ envelope: ENVELOPE, post: undefined })
  })

  it('turns a bare permalink into a manual capture with the canonical URL', () => {
    const capture = postCaptureOf({ ...ENVELOPE, url: 'https://twitter.com/jack/status/20?s=46' })
    expect(capture.envelope.url).toBe('https://x.com/jack/status/20')
    expect(capture.post).toEqual({ provider: 'x', id: '20', trigger: 'manual' })
  })

  it('spells the URL from the block, preferring the author handle over the page URL', () => {
    const post = { provider: 'x', id: '20', trigger: 'bookmark' } as const
    expect(
      postCaptureOf({
        ...ENVELOPE,
        url: 'https://x.com/i/status/20',
        post: { ...post, author: { name: 'jack', handle: 'jack' } },
      }).envelope.url,
    ).toBe('https://x.com/jack/status/20')
    expect(
      postCaptureOf({ ...ENVELOPE, url: 'https://x.com/jack/status/20', post }).envelope.url,
    ).toBe('https://x.com/jack/status/20')
    expect(
      postCaptureOf({ ...ENVELOPE, url: 'https://x.com/i/status/20', post }).envelope.url,
    ).toBe('https://x.com/i/status/20')
  })
})
