import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureBookmarkRequest,
  saveBookmark,
  parseCreateBookmark,
  type BookmarkRequest,
} from './x-bookmarks'
import { browser } from 'wxt/browser'
import { enqueueCapture } from './flush'
import { readBookmarkSettings, invalidateBookmarkCapture } from './bookmark-settings'
const { tabMock, permissionMock } = vi.hoisted(() => ({
  tabMock: vi.fn(async () => ({ incognito: false })),
  permissionMock: vi.fn(async () => true),
}))
vi.mock('wxt/browser', () => ({
  browser: {
    tabs: { get: tabMock },
    permissions: { contains: permissionMock },
  },
}))
vi.mock('./flush', () => ({
  enqueueCapture: vi.fn(async () => {}),
  flushQueue: vi.fn(async () => {}),
}))
vi.mock('./bookmark-settings', async (original) => ({
  ...(await original<typeof import('./bookmark-settings')>()),
  readBookmarkSettings: vi.fn(async () => ({
    enabled: true,
    presentation: 'link',
    targetGraphId: 'a'.repeat(64),
  })),
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
    requestBody: { raw: [{ bytes: new TextEncoder().encode(body).buffer }] },
  }
}

describe('CreateBookmark observer', () => {
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

it.each(['manual', 'request-intent'] as const)(
  'refuses %s bookmarks from incognito tabs in a spanning worker',
  async (evidence) => {
    tabMock.mockResolvedValueOnce({ incognito: true })
    await expect(saveBookmark('20', evidence, 1)).rejects.toThrow('incognito')
    expect(enqueueCapture).not.toHaveBeenCalled()
  },
)

it('invalidates an old request even if opt-in is turned off then on during permission lookup', async () => {
  const permission = Promise.withResolvers<boolean>()
  permissionMock.mockReturnValueOnce(permission.promise)
  const save = saveBookmark('20', 'request-intent', 1)
  await vi.waitFor(() => expect(browser.permissions.contains).toHaveBeenCalled())
  invalidateBookmarkCapture()
  invalidateBookmarkCapture()
  permission.resolve(true)
  await save
  expect(enqueueCapture).not.toHaveBeenCalled()
})

it('checks permission before preferences and invalidates pending admission', async () => {
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let admitted = false
  vi.mocked(enqueueCapture).mockImplementationOnce(async (_wire, allowed) => {
    reached.resolve()
    await release.promise
    admitted = allowed?.() ?? true
  })
  const save = saveBookmark('20', 'request-intent', 1)
  await reached.promise
  expect(permissionMock.mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(readBookmarkSettings).mock.invocationCallOrder[0]!,
  )
  invalidateBookmarkCapture()
  release.resolve()
  await save
  expect(admitted).toBe(false)
})

it('does not inspect request bodies when capture is disabled', async () => {
  vi.mocked(readBookmarkSettings).mockResolvedValueOnce({ enabled: false, presentation: 'link' })
  const body = vi.fn(() => request().requestBody)
  const details = { ...request(), timeStamp: Date.now() }
  Object.defineProperty(details, 'requestBody', { get: body })
  await captureBookmarkRequest(details)
  expect(body).not.toHaveBeenCalled()
  expect(enqueueCapture).not.toHaveBeenCalled()
})
