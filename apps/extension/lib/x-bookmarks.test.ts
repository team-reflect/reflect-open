import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureBookmarkRequest, parseCreateBookmark, type BookmarkRequest } from './x-bookmarks'
import { enqueueCapture } from './flush'
import { readBookmarkSettings } from './bookmark-settings'

const { tabMock } = vi.hoisted(() => ({ tabMock: vi.fn(async () => ({ incognito: false })) }))
vi.mock('wxt/browser', () => ({ browser: { tabs: { get: tabMock } } }))
vi.mock('./flush', () => ({
  enqueueCapture: vi.fn(async () => {}),
  flushQueue: vi.fn(async () => {}),
}))
vi.mock('./bookmark-settings', () => ({
  readBookmarkSettings: vi.fn(async () => ({ enabled: true })),
}))
beforeEach(() => {
  vi.clearAllMocks()
})

function request(body = '{"variables":{"tweet_id":"20"}}'): BookmarkRequest {
  return {
    method: 'POST',
    url: 'https://x.com/i/api/graphql/hash/CreateBookmark',
    initiator: 'https://x.com',
    tabId: 1,
    timeStamp: Date.UTC(2026, 8, 9, 4),
    requestBody: { raw: [{ bytes: new TextEncoder().encode(body).buffer }] },
  }
}

describe('parseCreateBookmark', () => {
  it('reads string IDs, including bodies split across upload chunks', () => {
    const details = request()
    const bytes = new TextEncoder().encode('{"variables":{"tweet_id":"1234567890123456789"}}')
    details.requestBody = {
      raw: [{ bytes: bytes.slice(0, 9).buffer }, { bytes: bytes.slice(9).buffer }],
    }
    expect(parseCreateBookmark(details)).toBe('1234567890123456789')
  })
  it.each([
    { method: 'GET' },
    { url: 'https://x.com/i/api/graphql/hash/DeleteBookmark' },
    { url: 'https://x.com.evil.test/i/api/graphql/hash/CreateBookmark' },
    { initiator: 'https://evil.test' },
    { initiator: undefined },
    { tabId: -1 },
    { url: 'invalid' },
  ])('ignores unrelated requests: %j', (patch) => {
    expect(parseCreateBookmark({ ...request(), ...patch })).toBeUndefined()
  })
  it('rejects malformed, numeric, oversized, and invalid UTF-8 bodies', () => {
    for (const body of ['{', '{"variables":{"tweet_id":20}}', ' '.repeat(65537)])
      expect(parseCreateBookmark(request(body))).toBeUndefined()
    expect(
      parseCreateBookmark({
        ...request(),
        requestBody: { raw: [{ bytes: new Uint8Array([255]).buffer }] },
      }),
    ).toBeUndefined()
  })
})

describe('captureBookmarkRequest', () => {
  it('queues a v2 envelope stamped with the request time', async () => {
    await captureBookmarkRequest(request())
    expect(enqueueCapture).toHaveBeenCalledWith({
      envelope: expect.objectContaining({
        version: 2,
        kind: 'x-bookmark',
        postId: '20',
        capturedAt: '2026-09-09T04:00:00.000Z',
      }),
    })
  })
  it('ignores incognito tabs', async () => {
    tabMock.mockResolvedValueOnce({ incognito: true })
    await captureBookmarkRequest(request())
    expect(enqueueCapture).not.toHaveBeenCalled()
  })
  it('does not inspect request bodies after the user opts out', async () => {
    vi.mocked(readBookmarkSettings).mockResolvedValueOnce({ enabled: false })
    const body = vi.fn(() => request().requestBody)
    const details = request()
    Object.defineProperty(details, 'requestBody', { get: body })
    await captureBookmarkRequest(details)
    expect(body).not.toHaveBeenCalled()
    expect(enqueueCapture).not.toHaveBeenCalled()
  })
})
