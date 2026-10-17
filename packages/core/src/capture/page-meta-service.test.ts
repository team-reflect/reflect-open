import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { WebFetchService } from '../link-preview/web-fetch-service.ts'
import { AppError } from '../errors.ts'
import type { CloudSafe } from '../privacy/cloud-safe.ts'
import { createTestWebFetchService } from '../testing/index.ts'
import { createPageMetaService, type PageMetaService } from './page-meta-service.ts'

let oembedFetchMock: MockInstance<WebFetchService['fetchOembed']>
let metaFetchMock: MockInstance<WebFetchService['fetchMeta']>
let pageMeta: PageMetaService

/**
 * The tests stand in for a caller that already passed the privacy gate.
 */
function scrape(url: string) {
  return pageMeta.scrape(url as CloudSafe<string>)
}

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
  const webFetch = createTestWebFetchService()
  oembedFetchMock = vi.spyOn(webFetch, 'fetchOembed')
  metaFetchMock = vi.spyOn(webFetch, 'fetchMeta')
  pageMeta = createPageMetaService({ webFetch })
})

describe('PageMetaService', () => {
  it('resolves a claimed URL through oEmbed without touching the HTML fetch', async () => {
    oembedFetchMock.mockResolvedValue(OEMBED_ANSWER)

    const meta = await scrape(VIDEO_URL)

    expect(meta).toEqual({
      title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
      description: null,
      siteName: 'YouTube',
    })
    expect(oembedFetchMock).toHaveBeenCalledWith(REQUEST_URL)
    expect(metaFetchMock).not.toHaveBeenCalled()
  })

  it('falls back to the HTML scrape when the endpoint refuses the id', async () => {
    oembedFetchMock.mockRejectedValue(new AppError('io', 'answered 400'))
    metaFetchMock.mockRejectedValue(new AppError('parse', 'fallback reached'))

    await expect(scrape(VIDEO_URL)).rejects.toMatchObject({
      message: 'fallback reached',
    })
  })

  it('falls back to the HTML scrape when the answer does not parse', async () => {
    oembedFetchMock.mockResolvedValue('not json')
    metaFetchMock.mockRejectedValue(new AppError('parse', 'fallback reached'))

    await expect(scrape(VIDEO_URL)).rejects.toMatchObject({
      message: 'fallback reached',
    })
  })

  it('falls back to the HTML scrape when the answer has a blank title', async () => {
    oembedFetchMock.mockResolvedValue('{"title":"   "}')
    metaFetchMock.mockRejectedValue(new AppError('parse', 'fallback reached'))

    await expect(scrape(VIDEO_URL)).rejects.toMatchObject({
      message: 'fallback reached',
    })
  })

  it('propagates a transient oEmbed failure for retry', async () => {
    oembedFetchMock.mockRejectedValue(new AppError('network', 'offline'))

    await expect(scrape(VIDEO_URL)).rejects.toMatchObject({ kind: 'network' })
    expect(metaFetchMock).not.toHaveBeenCalled()
  })

  it('sends unclaimed URLs straight to the HTML fetch', async () => {
    metaFetchMock.mockRejectedValue(new AppError('parse', 'fallback reached'))

    await expect(scrape('https://example.com/article')).rejects.toMatchObject({
      message: 'fallback reached',
    })
    expect(oembedFetchMock).not.toHaveBeenCalled()
  })
})
