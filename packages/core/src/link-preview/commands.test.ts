import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import { cloudSafeLinkHref } from '../privacy/checkers'
import { linkPreviewFetchHtml, linkPreviewFetchIcon } from './commands'

function publicUrl(url: string) {
  return cloudSafeLinkHref({ path: 'notes/public.md', isPrivate: false }, url)
}

afterEach(() => setBridge(null))

describe('link preview IPC contracts', () => {
  it('accepts the bounded HTML response shape', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({ html: '<title>A</title>', finalUrl: 'https://x.test/' })
    setBridge({ invoke, listen: async () => () => {} })
    await expect(linkPreviewFetchHtml(publicUrl('https://x.test'))).resolves.toEqual({
      html: '<title>A</title>',
      finalUrl: 'https://x.test/',
    })
  })

  it('enforces exact HTML and favicon IPC size limits', async () => {
    const maxHtml = 'x'.repeat(2 * 1024 * 1024)
    setBridge({
      invoke: async () => ({ html: maxHtml, finalUrl: 'https://x.test/' }),
      listen: async () => () => {},
    })
    await expect(linkPreviewFetchHtml(publicUrl('https://x.test'))).resolves.toMatchObject({
      html: maxHtml,
    })

    setBridge({
      invoke: async () => ({ html: `${maxHtml}x`, finalUrl: 'https://x.test/' }),
      listen: async () => () => {},
    })
    await expect(linkPreviewFetchHtml(publicUrl('https://x.test'))).rejects.toMatchObject({
      kind: 'parse',
    })

    const prefix = 'data:image/png;base64,'
    const maxPayloadLength = Math.floor((64 * 1024 - prefix.length) / 4) * 4
    const maxIcon = `${prefix}${'A'.repeat(maxPayloadLength)}`
    setBridge({ invoke: async () => maxIcon, listen: async () => () => {} })
    await expect(linkPreviewFetchIcon(publicUrl('https://x.test/icon'))).resolves.toBe(maxIcon)

    setBridge({ invoke: async () => `${maxIcon}AAAA`, listen: async () => () => {} })
    await expect(linkPreviewFetchIcon(publicUrl('https://x.test/icon'))).rejects.toMatchObject({
      kind: 'parse',
    })
  })

  it('rejects malformed HTML and favicon payloads', async () => {
    setBridge({
      invoke: async () => ({ html: 'x', finalUrl: 'not a URL' }),
      listen: async () => () => {},
    })
    await expect(linkPreviewFetchHtml(publicUrl('https://x.test'))).rejects.toMatchObject({
      kind: 'parse',
    })

    setBridge({
      invoke: async () => 'data:image/svg+xml;base64,PHN2Zz4=',
      listen: async () => () => {},
    })
    await expect(linkPreviewFetchIcon(publicUrl('https://x.test/icon'))).rejects.toMatchObject({
      kind: 'parse',
    })
  })

  it('rejects non-HTTP final URLs and malformed PNG data URLs', async () => {
    setBridge({
      invoke: async () => ({ html: 'x', finalUrl: 'file:///tmp/page' }),
      listen: async () => () => {},
    })
    await expect(linkPreviewFetchHtml(publicUrl('https://x.test'))).rejects.toMatchObject({
      kind: 'parse',
    })

    setBridge({
      invoke: async () => 'data:image/png;base64,not base64',
      listen: async () => () => {},
    })
    await expect(linkPreviewFetchIcon(publicUrl('https://x.test/icon'))).rejects.toMatchObject({
      kind: 'parse',
    })
  })
})
