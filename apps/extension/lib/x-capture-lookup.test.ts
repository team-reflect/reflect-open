import { permalinkPostId } from './x-capture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requestXTweet } from '@post-embed/exporter/x/bridge'
import { lookupCapturedPost } from './x-capture-lookup'
import { captureFixture } from './x-capture-fixture'
import { capturedPostSchema } from './x-capture-messages'

vi.mock('@post-embed/exporter/x/bridge', () => ({ requestXTweet: vi.fn() }))
const token = '6b9dbd9f-31ef-45aa-9148-c3c38cbcf59b'
const pageUrl = 'https://x.com/example/status/20'
beforeEach(() => vi.resetAllMocks())

describe('capture lookup', () => {
  it.each([false, true])(
    'returns identical normalized posts for protected=%s without wrapper data',
    async (isProtected) => {
      vi.mocked(requestXTweet).mockResolvedValue({
        post: captureFixture(),
        protected: isProtected,
        operation: 'TweetDetail',
        capturedAt: 1,
        raw: { secret: 'not forwarded' },
      })
      expect(await lookupCapturedPost('20', token, () => pageUrl)).toEqual({
        ok: true,
        pageUrl,
        documentToken: token,
        post: captureFixture(),
      })
    },
  )
  it('rejects a snapshot for the wrong post', async () => {
    vi.mocked(requestXTweet).mockResolvedValue({
      post: captureFixture(),
      protected: false,
      operation: 'TweetDetail',
      capturedAt: 1,
    })
    expect(await lookupCapturedPost('21', token, () => pageUrl)).toEqual({
      ok: false,
      reason: 'wrong-post',
    })
  })
  it('reports a cache miss and never requests a public proxy', async () => {
    vi.mocked(requestXTweet).mockResolvedValue(undefined)
    expect(await lookupCapturedPost('20', token, () => pageUrl)).toEqual({
      ok: false,
      reason: 'not-observed',
    })
    expect(requestXTweet).toHaveBeenCalledOnce()
  })
  it('rejects navigation during an outstanding lookup', async () => {
    const url = vi
      .fn()
      .mockReturnValueOnce(pageUrl)
      .mockReturnValue('https://x.com/example/status/21')
    vi.mocked(requestXTweet).mockResolvedValue({
      post: captureFixture(),
      protected: false,
      operation: 'TweetDetail',
      capturedAt: 1,
    })
    expect(await lookupCapturedPost('20', token, url)).toEqual({
      ok: false,
      reason: 'page-changed',
    })
  })
  it('converts bridge rejection to a retryable diagnostic', async () => {
    vi.mocked(requestXTweet).mockRejectedValue(new Error('timeout'))
    expect(await lookupCapturedPost('20', token, () => pageUrl)).toEqual({
      ok: false,
      reason: 'lookup-failed',
    })
  })
  it.each([undefined, null, {}, { id: '20' }, { ...captureFixture(), id: 'bad' }])(
    'rejects malformed input',
    (input) => {
      expect(capturedPostSchema.safeParse(input).success).toBe(false)
    },
  )
})

describe('permalink targeting', () => {
  it.each([
    'https://x.com/example/status/20',
    'https://x.com/i/web/status/20',
    'https://x.com/example/status/20/photo/1',
  ])('reads a permalink: %s', (url) => {
    expect(permalinkPostId(url)).toBe('20')
  })
  it.each([
    'https://x.com/home',
    'https://x.com/example/status/20bad',
    'https://x.com.evil.test/example/status/20',
    'https://example.com/status/20',
    'invalid',
    undefined,
  ])('rejects a non-permalink: %s', (url) => {
    expect(permalinkPostId(url)).toBeUndefined()
  })
})
