import type { ReactElement } from 'react'
import { createTestNativeChromeHost } from '@reflect/app/testing'
import { describe, expect, it, vi } from 'vitest'
import { useScreenChrome } from '@/mobile/chrome/chrome-renderer.ts'
import { ChromeTopBar } from '@/mobile/chrome/chrome-top-bar.tsx'
import { nativeChromeOptions } from '@/test-utils/native-chrome.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'

function Screen(): ReactElement {
  useScreenChrome({ trailing: [{ id: 'more', title: 'More' }] })
  return <p>screen</p>
}

describe('NativeChromeRenderer', () => {
  it('posts the bar of a new screen in its first state', async () => {
    const host = createTestNativeChromeHost()

    await renderInApp(<Screen />, nativeChromeOptions(host))

    await vi.waitFor(() => {
      expect(host.posted).toContainEqual(expect.objectContaining({ type: 'state' }))
    })
    const first = host.posted
      .map((message) => message as { type: string; trailing?: { id: string }[] })
      .find((message) => message.type === 'state')
    expect(first?.trailing?.map((button) => button.id)).toEqual(['more'])
  })

  it('keeps the corner space in the header row only while the shell draws the corners there', async () => {
    const host = createTestNativeChromeHost()
    const view = await renderInApp(
      <ChromeTopBar
        back={vi.fn()}
        trailing={[{ id: 'more', title: 'More', icon: 'ellipsis' }]}
        title={<h1>Tag</h1>}
      />,
      nativeChromeOptions(host),
    )
    const back = (): Element | null => view.container.querySelector('[aria-label="Back"]')
    await vi.waitFor(() => {
      expect(host.posted).toContainEqual({ type: 'chromeReady' })
    })
    expect(back()).not.toBeNull()

    host.sendIntent({ type: 'layout', cornersInHeaderRow: false })
    await vi.waitFor(() => {
      expect(back()).toBeNull()
    })
    expect(view.container.querySelector('[aria-label="More"]')).toBeNull()

    host.sendIntent({ type: 'layout', cornersInHeaderRow: true })
    await vi.waitFor(() => {
      expect(back()).not.toBeNull()
    })
  })
})
