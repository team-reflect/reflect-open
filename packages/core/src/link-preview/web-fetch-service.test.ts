import { describe, expect, it } from 'vitest'
import { cloudSafeLinkHref } from '../privacy/privacy-service.ts'
import { createTestIpcBridgeService } from '../testing/index.ts'
import { createWebFetchService } from './web-fetch-service.ts'

function publicUrl(url: string) {
  return cloudSafeLinkHref({ path: 'notes/public.md', isPrivate: false }, url)
}

function serviceAnswering(command: string, answer: unknown) {
  const ipc = createTestIpcBridgeService({ commands: { [command]: () => answer } })
  return { ipc, webFetch: createWebFetchService({ ipc }) }
}

describe('createWebFetchService', () => {
  it('sends capture fetches as their commands', async () => {
    const ipc = createTestIpcBridgeService({
      commands: {
        capture_meta_fetch: () => '<title>A</title>',
        capture_oembed_fetch: () => '{}',
        capture_link_preview: () => null,
      },
    })
    const webFetch = createWebFetchService({ ipc })
    const url = publicUrl('https://x.test/a')

    await expect(webFetch.fetchMeta(url)).resolves.toBe('<title>A</title>')
    await expect(webFetch.fetchOembed(url)).resolves.toBe('{}')
    await expect(webFetch.fetchLinkPreviewImage(url)).resolves.toBeNull()
    expect(ipc.calls()).toEqual([
      { command: 'capture_meta_fetch', args: { url } },
      { command: 'capture_oembed_fetch', args: { url } },
      { command: 'capture_link_preview', args: { url } },
    ])
  })

  it('accepts the bounded HTML response shape', async () => {
    const { ipc, webFetch } = serviceAnswering('link_preview_fetch_html', {
      html: '<title>A</title>',
      finalUrl: 'https://x.test/',
    })
    await expect(webFetch.fetchLinkPreviewHtml(publicUrl('https://x.test'))).resolves.toEqual({
      html: '<title>A</title>',
      finalUrl: 'https://x.test/',
    })
    expect(ipc.calls()).toEqual([
      { command: 'link_preview_fetch_html', args: { url: 'https://x.test' } },
    ])
  })

  it('enforces exact HTML and favicon IPC size limits', async () => {
    const maxHtml = 'x'.repeat(2 * 1024 * 1024)
    const { ipc, webFetch } = serviceAnswering('link_preview_fetch_html', {
      html: maxHtml,
      finalUrl: 'https://x.test/',
    })
    await expect(webFetch.fetchLinkPreviewHtml(publicUrl('https://x.test'))).resolves.toMatchObject(
      { html: maxHtml },
    )

    ipc.onCommand('link_preview_fetch_html', () => ({
      html: `${maxHtml}x`,
      finalUrl: 'https://x.test/',
    }))
    await expect(webFetch.fetchLinkPreviewHtml(publicUrl('https://x.test'))).rejects.toMatchObject({
      kind: 'parse',
    })

    const prefix = 'data:image/png;base64,'
    const maxPayloadLength = Math.floor((64 * 1024 - prefix.length) / 4) * 4
    const maxIcon = `${prefix}${'A'.repeat(maxPayloadLength)}`
    ipc.onCommand('link_preview_fetch_icon', () => maxIcon)
    await expect(webFetch.fetchLinkPreviewIcon(publicUrl('https://x.test/icon'))).resolves.toBe(
      maxIcon,
    )

    ipc.onCommand('link_preview_fetch_icon', () => `${maxIcon}AAAA`)
    await expect(
      webFetch.fetchLinkPreviewIcon(publicUrl('https://x.test/icon')),
    ).rejects.toMatchObject({ kind: 'parse' })
  })

  it('rejects malformed HTML and favicon payloads', async () => {
    const { ipc, webFetch } = serviceAnswering('link_preview_fetch_html', {
      html: 'x',
      finalUrl: 'not a URL',
    })
    await expect(webFetch.fetchLinkPreviewHtml(publicUrl('https://x.test'))).rejects.toMatchObject({
      kind: 'parse',
    })

    ipc.onCommand('link_preview_fetch_icon', () => 'data:image/svg+xml;base64,PHN2Zz4=')
    await expect(
      webFetch.fetchLinkPreviewIcon(publicUrl('https://x.test/icon')),
    ).rejects.toMatchObject({ kind: 'parse' })
  })

  it('rejects non-HTTP final URLs and malformed PNG data URLs', async () => {
    const { ipc, webFetch } = serviceAnswering('link_preview_fetch_html', {
      html: 'x',
      finalUrl: 'file:///tmp/page',
    })
    await expect(webFetch.fetchLinkPreviewHtml(publicUrl('https://x.test'))).rejects.toMatchObject({
      kind: 'parse',
    })

    ipc.onCommand('link_preview_fetch_icon', () => 'data:image/png;base64,not base64')
    await expect(
      webFetch.fetchLinkPreviewIcon(publicUrl('https://x.test/icon')),
    ).rejects.toMatchObject({ kind: 'parse' })
  })
})
