import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureXPostRequest,
  getXPostKind,
  parseXPostId,
  registerXPostObserver,
  type XPostRequest,
} from './x-post-capture'
import { readLikeSettings } from './like-settings'
import { saveXPost } from './x-save'
import { readBookmarkSettings } from './bookmark-settings'

const { tabMock, observe } = vi.hoisted(() => ({
  tabMock: vi.fn(async () => ({ incognito: false })),
  observe: vi.fn(),
}))
vi.mock('wxt/browser', () => ({
  browser: { tabs: { get: tabMock }, webRequest: { onBeforeRequest: { addListener: observe } } },
}))
vi.mock('./x-save', () => ({ saveXPost: vi.fn(async () => {}) }))
vi.mock('./like-settings', () => ({ readLikeSettings: vi.fn(async () => ({ enabled: false })) }))
vi.mock('./bookmark-settings', () => ({
  readBookmarkSettings: vi.fn(async () => ({ enabled: true })),
}))
beforeEach(() => {
  vi.resetAllMocks()
  tabMock.mockResolvedValue({ incognito: false })
  vi.mocked(readBookmarkSettings).mockResolvedValue({ enabled: true })
  vi.mocked(readLikeSettings).mockResolvedValue({ enabled: false })
})

function request(body = '{"variables":{"tweet_id":"20"}}'): XPostRequest {
  return {
    method: 'POST',
    url: 'https://x.com/i/api/graphql/hash/CreateBookmark',
    initiator: 'https://x.com',
    tabId: 1,
    timeStamp: Date.UTC(2026, 8, 9, 4),
    requestBody: { raw: [{ bytes: new TextEncoder().encode(body).buffer }] },
  }
}

describe('getXPostKind', () => {
  it.each([
    { method: 'GET' },
    { url: 'https://x.com/i/api/graphql/hash/DeleteBookmark' },
    { url: 'https://x.com.evil.test/i/api/graphql/hash/CreateBookmark' },
    { initiator: 'https://evil.test' },
    { initiator: undefined },
    { tabId: -1 },
    { url: 'invalid' },
  ])('ignores unrelated requests: %j', (patch) => {
    expect(getXPostKind({ ...request(), ...patch })).toBeUndefined()
  })
})

describe('parseXPostId', () => {
  it('reads string IDs, including bodies split across upload chunks', () => {
    const details = request()
    const bytes = new TextEncoder().encode('{"variables":{"tweet_id":"1234567890123456789"}}')
    details.requestBody = {
      raw: [{ bytes: bytes.slice(0, 9).buffer }, { bytes: bytes.slice(9).buffer }],
    }
    expect(parseXPostId(details)).toBe('1234567890123456789')
  })
  it('rejects malformed, numeric, oversized, and invalid UTF-8 bodies', () => {
    for (const body of ['{', '{"variables":{"tweet_id":20}}', ' '.repeat(65537)])
      expect(parseXPostId(request(body))).toBeUndefined()
    expect(
      parseXPostId({
        ...request(),
        requestBody: { raw: [{ bytes: new Uint8Array([255]).buffer }] },
      }),
    ).toBeUndefined()
  })
})

describe('captureXPostRequest', () => {
  it('queues a v2 envelope stamped with the request time', async () => {
    await captureXPostRequest(request())
    expect(saveXPost).toHaveBeenCalledWith(1, '20', '2026-09-09T04:00:00.000Z', {
      kind: 'x-bookmark',
      shouldAdmit: expect.any(Function),
    })
  })
  it('ignores incognito tabs', async () => {
    tabMock.mockResolvedValueOnce({ incognito: true })
    await captureXPostRequest(request())
    expect(saveXPost).not.toHaveBeenCalled()
  })
  it('does not inspect request bodies after the user opts out', async () => {
    vi.mocked(readBookmarkSettings).mockResolvedValueOnce({ enabled: false })
    const body = vi.fn(() => request().requestBody)
    const details = request()
    Object.defineProperty(details, 'requestBody', { get: body })
    await captureXPostRequest(details)
    expect(body).not.toHaveBeenCalled()
    expect(saveXPost).not.toHaveBeenCalled()
  })
})

it('captures likes independently and ignores unlike requests', async () => {
  vi.mocked(readLikeSettings).mockResolvedValueOnce({ enabled: true })
  vi.mocked(readBookmarkSettings).mockResolvedValueOnce({ enabled: false })
  await captureXPostRequest({
    ...request(),
    url: 'https://x.com/i/api/graphql/newHash/FavoriteTweet',
  })
  expect(saveXPost).toHaveBeenCalledWith(1, '20', '2026-09-09T04:00:00.000Z', {
    kind: 'x-like',
    shouldAdmit: expect.any(Function),
  })
  vi.mocked(saveXPost).mockClear()
  await captureXPostRequest({
    ...request(),
    url: 'https://x.com/i/api/graphql/newHash/UnfavoriteTweet',
  })
  expect(saveXPost).not.toHaveBeenCalled()
})

it('does not inspect like bodies when likes are disabled', async () => {
  vi.mocked(readLikeSettings).mockResolvedValueOnce({ enabled: false })
  const details = { ...request(), url: 'https://x.com/i/api/graphql/hash/FavoriteTweet' }
  const body = vi.fn(() => request().requestBody)
  Object.defineProperty(details, 'requestBody', { get: body })
  await captureXPostRequest(details)
  expect(body).not.toHaveBeenCalled()
  expect(saveXPost).not.toHaveBeenCalled()
})

it('ignores a tab that disappears before inspection', async () => {
  tabMock.mockRejectedValueOnce(new Error('No tab'))
  await captureXPostRequest(request())
  expect(saveXPost).not.toHaveBeenCalled()
})

it('registers both narrow operations synchronously at worker start', () => {
  registerXPostObserver()
  expect(observe).toHaveBeenCalledWith(
    expect.any(Function),
    {
      urls: [
        'https://x.com/i/api/graphql/*/CreateBookmark',
        'https://x.com/i/api/graphql/*/FavoriteTweet',
      ],
    },
    ['requestBody'],
  )
})
