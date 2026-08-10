import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReflectError } from '../errors'
import { captureMetaFetch, captureOEmbedFetch } from '../graph/commands'
import { scrapePageMeta } from './meta-scrape'

vi.mock('../graph/commands', () => ({
  captureMetaFetch: vi.fn(),
  captureOEmbedFetch: vi.fn(),
}))

const oembedFetchMock = vi.mocked(captureOEmbedFetch)
const metaFetchMock = vi.mocked(captureMetaFetch)

const VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
const REQUEST_URL =
  'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json'
const OEMBED_ANSWER = JSON.stringify({
  title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
  author_name: 'Rick Astley',
  provider_name: 'YouTube',
  type: 'video',
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('scrapePageMeta', () => {
  it('resolves a claimed URL through oEmbed without touching the HTML fetch', async () => {
    oembedFetchMock.mockResolvedValue(OEMBED_ANSWER)

    const meta = await scrapePageMeta(VIDEO_URL)

    expect(meta).toEqual({
      title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
      description: null,
      siteName: 'YouTube',
    })
    expect(oembedFetchMock).toHaveBeenCalledWith(REQUEST_URL)
    expect(metaFetchMock).not.toHaveBeenCalled()
  })

  it('falls back to the HTML scrape when the endpoint refuses the id', async () => {
    oembedFetchMock.mockRejectedValue(new ReflectError('io', 'answered 400'))
    metaFetchMock.mockRejectedValue(new ReflectError('parse', 'fallback reached'))

    await expect(scrapePageMeta(VIDEO_URL)).rejects.toMatchObject({
      message: 'fallback reached',
    })
  })

  it('falls back to the HTML scrape when the answer does not parse', async () => {
    oembedFetchMock.mockResolvedValue('not json')
    metaFetchMock.mockRejectedValue(new ReflectError('parse', 'fallback reached'))

    await expect(scrapePageMeta(VIDEO_URL)).rejects.toMatchObject({
      message: 'fallback reached',
    })
  })

  it('falls back to the HTML scrape when the answer has a blank title', async () => {
    oembedFetchMock.mockResolvedValue('{"title":"   "}')
    metaFetchMock.mockRejectedValue(new ReflectError('parse', 'fallback reached'))

    await expect(scrapePageMeta(VIDEO_URL)).rejects.toMatchObject({
      message: 'fallback reached',
    })
  })

  it('propagates a transient oEmbed failure for retry', async () => {
    oembedFetchMock.mockRejectedValue(new ReflectError('network', 'offline'))

    await expect(scrapePageMeta(VIDEO_URL)).rejects.toMatchObject({ kind: 'network' })
    expect(metaFetchMock).not.toHaveBeenCalled()
  })

  it('sends unclaimed URLs straight to the HTML fetch', async () => {
    metaFetchMock.mockRejectedValue(new ReflectError('parse', 'fallback reached'))

    await expect(scrapePageMeta('https://example.com/article')).rejects.toMatchObject({
      message: 'fallback reached',
    })
    expect(oembedFetchMock).not.toHaveBeenCalled()
  })
})
