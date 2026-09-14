import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectProbeMedia, probeMedia } from './x-capture-media'
import { captureFixture } from './x-capture-fixture'

afterEach(() => vi.unstubAllGlobals())

describe('media selection', () => {
  it('keeps both posts and posters, selects one MP4, and preserves unavailable diagnostics', () => {
    const post = captureFixture()
    const before = structuredClone(post)
    expect(collectProbeMedia(post)).toEqual([
      {
        slot: 'post.avatar',
        unavailable: false,
        kind: 'image',
        url: 'https://pbs.twimg.com/avatar.jpg',
      },
      {
        slot: 'post.media.0',
        unavailable: false,
        kind: 'image',
        url: 'https://pbs.twimg.com/photo.jpg',
      },
      {
        slot: 'post.media.1.poster',
        unavailable: false,
        kind: 'image',
        url: 'https://pbs.twimg.com/poster.jpg',
      },
      {
        slot: 'post.media.1',
        unavailable: false,
        kind: 'video',
        url: 'https://video.twimg.com/high.mp4',
      },
      {
        slot: 'quote.media.0.poster',
        unavailable: true,
        kind: 'image',
        url: 'https://pbs.twimg.com/quote.jpg',
      },
      { slot: 'quote.media.0', unavailable: true, kind: 'unsupported', reason: 'hls-only' },
    ])
    expect(post).toEqual(before)
  })
  it('does not confuse missing sources with HLS-only and supports MP4 GIFs without bitrate', () => {
    const post = captureFixture()
    delete post.quote
    post.media = [
      { type: 'video', width: 1, height: 1, sources: [] },
      {
        type: 'gif',
        width: 1,
        height: 1,
        sources: [{ type: 'video/mp4', url: 'https://video.twimg.com/gif.mp4' }],
      },
    ]
    expect(collectProbeMedia(post).slice(1)).toEqual([
      { slot: 'post.media.0', unavailable: false, kind: 'unsupported', reason: 'no-source' },
      {
        slot: 'post.media.1',
        unavailable: false,
        kind: 'video',
        url: 'https://video.twimg.com/gif.mp4',
      },
    ])
  })
})

describe('media reader', () => {
  it.each([
    'http://pbs.twimg.com/photo.jpg',
    'https://pbs.twimg.com.evil.test/photo.jpg',
    'https://pbs.twimg.com@evil.test/photo.jpg',
    'https://user:password@pbs.twimg.com/photo.jpg',
    'https://pbs.twimg.com:8443/photo.jpg',
    'http://localhost/file',
    'not-a-url',
  ])('rejects an untrusted source before fetching: %s', async (url) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(probeMedia(url, 'image')).rejects.toThrow('media-origin-not-allowed')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads every chunk, retains only 32 signature bytes, and uses credentialed non-redirecting fetch', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        controller.enqueue(new Uint8Array(40).fill(3))
        controller.close()
      },
    })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(stream, {
        headers: { 'content-type': 'video/mp4; charset=binary' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(probeMedia('https://video.twimg.com/movie.mp4', 'video')).resolves.toEqual({
      bytes: 42,
      mime: 'video/mp4',
      signature: [1, 2, ...new Array<number>(30).fill(3)],
    })
    expect(fetchMock).toHaveBeenCalledWith('https://video.twimg.com/movie.mp4', {
      credentials: 'include',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    })
    expect(stream.locked).toBe(false)
  })

  it.each([
    [403, 'image/jpeg', 'media-http-403'],
    [200, 'text/html', 'unexpected-media-type'],
  ])('cancels rejected responses (%s, %s)', async (status, mime, reason) => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ cancel })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status,
          headers: { 'content-type': mime },
        }),
      ),
    )
    await expect(probeMedia('https://pbs.twimg.com/photo.jpg', 'image')).rejects.toThrow(reason)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('reports an empty body instead of a successful read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array(), {
          headers: { 'content-type': 'image/png' },
        }),
      ),
    )
    await expect(probeMedia('https://pbs.twimg.com/photo.png', 'image')).rejects.toThrow(
      'empty-media-body',
    )
  })

  it('cancels an oversized stream and releases its lock without retaining the full media', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024 * 1024 + 1))
      },
      cancel,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          headers: { 'content-type': 'video/mp4' },
        }),
      ),
    )
    await expect(probeMedia('https://video.twimg.com/large.mp4', 'video')).rejects.toThrow(
      'probe-size-budget',
    )
    expect(cancel).toHaveBeenCalledOnce()
    expect(stream.locked).toBe(false)
  })

  it('distinguishes a deadline from network errors and does not expose signed URLs in errors', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort())
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('https://video.twimg.com/secret?token=private')),
    )
    try {
      await expect(probeMedia('https://video.twimg.com/movie.mp4', 'video')).rejects.toThrow(
        'probe-time-budget',
      )
    } finally {
      timeout.mockRestore()
    }
    await expect(probeMedia('https://video.twimg.com/movie.mp4', 'video')).rejects.toThrow(
      'media-network-error',
    )
  })
})
