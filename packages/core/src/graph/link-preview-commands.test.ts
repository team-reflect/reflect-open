import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import { linkPreviewFetchHtml, linkPreviewFetchIcon } from './commands'

afterEach(() => setBridge(null))

describe('link preview IPC contracts', () => {
  it('accepts the bounded HTML response shape', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({ html: '<title>A</title>', finalUrl: 'https://x.test/' })
    setBridge({ invoke, listen: async () => () => {} })
    await expect(linkPreviewFetchHtml('https://x.test')).resolves.toEqual({
      html: '<title>A</title>',
      finalUrl: 'https://x.test/',
    })
  })

  it('rejects malformed HTML and favicon payloads', async () => {
    setBridge({
      invoke: async () => ({ html: 'x', finalUrl: 'not a URL' }),
      listen: async () => () => {},
    })
    await expect(linkPreviewFetchHtml('https://x.test')).rejects.toMatchObject({ kind: 'parse' })

    setBridge({
      invoke: async () => 'data:image/svg+xml;base64,PHN2Zz4=',
      listen: async () => () => {},
    })
    await expect(linkPreviewFetchIcon('https://x.test/icon')).rejects.toMatchObject({
      kind: 'parse',
    })
  })

  it('rejects non-HTTP final URLs and malformed PNG data URLs', async () => {
    setBridge({
      invoke: async () => ({ html: 'x', finalUrl: 'file:///tmp/page' }),
      listen: async () => () => {},
    })
    await expect(linkPreviewFetchHtml('https://x.test')).rejects.toMatchObject({ kind: 'parse' })

    setBridge({
      invoke: async () => 'data:image/png;base64,not base64',
      listen: async () => () => {},
    })
    await expect(linkPreviewFetchIcon('https://x.test/icon')).rejects.toMatchObject({
      kind: 'parse',
    })
  })
})
