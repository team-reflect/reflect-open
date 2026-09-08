import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Browser } from 'wxt/browser'
import { captureWireMessageSchema } from '@reflect/core/capture-envelope'
import { bookmarkId, captureXBookmark, installXBookmarkListener } from './x-bookmarks'
import { hasXPermission, setXPermission, X_ORIGINS } from './x-permissions'

const mocks = vi.hoisted(() => ({
  contains: vi.fn(), request: vi.fn(), remove: vi.fn(), addListener: vi.fn(),
  enqueue: vi.fn(), flush: vi.fn(),
}))
vi.mock('wxt/browser', () => ({ browser: {
  permissions: { contains: mocks.contains, request: mocks.request, remove: mocks.remove },
  webRequest: { onBeforeRequest: { addListener: mocks.addListener } },
} }))
vi.mock('./flush', () => ({ enqueueCapture: mocks.enqueue, flushQueue: mocks.flush }))

const REQUEST: Browser.webRequest.OnBeforeRequestDetails = {
  url: 'https://x.com/i/api/graphql/operation-hash/CreateBookmark',
  method: 'POST', initiator: 'https://x.com', requestId: 'request-1', frameId: 0,
  parentFrameId: -1, tabId: -1, timeStamp: 0, type: 'xmlhttprequest',
  requestBody: { raw: [{ bytes: new TextEncoder().encode('{"variables":{"tweet_id":"1234567890123456789"}}').buffer }] },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.contains.mockResolvedValue(true)
  mocks.enqueue.mockResolvedValue(undefined)
  mocks.flush.mockResolvedValue(undefined)
})

describe('bookmark request capture', () => {
  it('registers synchronously without a permission read or blocking listener', () => {
    installXBookmarkListener()
    expect(mocks.addListener).toHaveBeenCalledWith(expect.any(Function), { urls: [
      'https://x.com/i/api/graphql/*/CreateBookmark',
      'https://twitter.com/i/api/graphql/*/CreateBookmark',
    ] }, ['requestBody'])
    expect(mocks.contains).not.toHaveBeenCalled()
  })

  it('persists a plain v1 envelope before flushing, including requests with no tab', async () => {
    await captureXBookmark(REQUEST)
    const wire = captureWireMessageSchema.parse(mocks.enqueue.mock.calls[0]?.[0])
    expect(wire.envelope).toMatchObject({ version: 1, url: 'https://x.com/i/status/1234567890123456789', source: 'extension' })
    expect(Object.keys(wire.envelope).sort()).toEqual(['capturedAt', 'id', 'source', 'title', 'url', 'version'])
    expect(mocks.enqueue.mock.invocationCallOrder[0]).toBeLessThan(mocks.flush.mock.invocationCallOrder[0] ?? 0)
  })

  it('keeps distinct request observations independent', async () => {
    await captureXBookmark(REQUEST)
    await captureXBookmark(REQUEST)
    const first = captureWireMessageSchema.parse(mocks.enqueue.mock.calls[0]?.[0])
    const second = captureWireMessageSchema.parse(mocks.enqueue.mock.calls[1]?.[0])
    expect(first.envelope.id).not.toBe(second.envelope.id)
  })

  it.each([
    { method: 'GET' }, { initiator: 'https://example.com' }, { initiator: 'null' },
    { url: REQUEST.url.replace('CreateBookmark', 'DeleteBookmark') },
    { url: REQUEST.url.replace('CreateBookmark', 'FavoriteTweet') },
    { url: REQUEST.url.replace('x.com', 'x.com.evil.com') },
  ])('ignores unrelated request %j', async (overrides) => {
    await captureXBookmark({ ...REQUEST, ...overrides })
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it('does not enqueue after revocation or partial permission grants', async () => {
    mocks.contains.mockResolvedValue(false)
    await captureXBookmark(REQUEST)
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it('does not flush a failed durable enqueue', async () => {
    mocks.enqueue.mockRejectedValueOnce(new Error('storage full'))
    await expect(captureXBookmark(REQUEST)).rejects.toThrow('storage full')
    expect(mocks.flush).not.toHaveBeenCalled()
  })

  it('joins raw chunks before decoding split UTF-8', () => {
    const bytes = new TextEncoder().encode('{"label":"😀","variables":{"tweet_id":"123"}}')
    const start = bytes.indexOf(0xf0) + 2
    expect(bookmarkId({ raw: [{ bytes: bytes.slice(0, start).buffer }, { bytes: bytes.slice(start).buffer }] })).toBe('123')
  })

  it.each([
    undefined, { error: 'unavailable' }, { raw: [{ file: '' }] },
    { raw: [{ bytes: new ArrayBuffer(65 * 1024) }] },
    { raw: [{ bytes: new Uint8Array([0xff]).buffer }] },
    { raw: [{ bytes: new TextEncoder().encode('{"variables":{"tweet_id":123}}').buffer }] },
  ])('ignores unavailable or invalid raw bodies', (body) => {
    expect(bookmarkId(body)).toBeNull()
  })
})

describe('X permission opt-in', () => {
  it('requests from the gesture before any asynchronous permission lookup', async () => {
    mocks.request.mockResolvedValue(false)
    mocks.contains.mockResolvedValue(false)
    const toggled = setXPermission(true)
    expect(mocks.request).toHaveBeenCalledWith({ origins: X_ORIGINS })
    expect(mocks.contains).not.toHaveBeenCalled()
    expect(await toggled).toBe(false)
  })
  it('revokes both origins and reads the resulting grant', async () => {
    mocks.remove.mockResolvedValue(true)
    mocks.contains.mockResolvedValue(false)
    expect(await setXPermission(false)).toBe(false)
    expect(mocks.remove).toHaveBeenCalledWith({ origins: X_ORIGINS })
    expect(await hasXPermission()).toBe(false)
  })
})
