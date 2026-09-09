import { describe, expect, it, vi } from 'vitest'
import { parseCreateBookmark, type BookmarkRequest } from './x-bookmarks'
vi.mock('wxt/browser', () => ({ browser: {} }))

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
