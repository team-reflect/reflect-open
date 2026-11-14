import type { ReactElement } from 'react'
import { createTestNativeChromeHost } from '@reflect/app/testing'
import { describe, expect, it, vi } from 'vitest'
import { useScreenChrome } from '@/mobile/chrome/chrome-renderer.ts'
import { ChromeTopBar } from '@/mobile/chrome/chrome-top-bar.tsx'
import { nativeChromeOptions } from '@/test-utils/native-chrome.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'

function Screen({ id = 'more' }: { id?: string | undefined }): ReactElement {
  useScreenChrome({ trailing: [{ id, title: id }] })
  return <p>screen</p>
}

function postedTrailing(host: ReturnType<typeof createTestNativeChromeHost>): string[][] {
  return host.posted
    .map((message) => message as { type: string; trailing?: { id: string }[] })
    .filter((message) => message.type === 'state')
    .map((message) => (message.trailing ?? []).map((button) => button.id))
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

  it('posts one state when a screen changes its buttons', async () => {
    const host = createTestNativeChromeHost()
    const view = await renderInApp(<Screen />, nativeChromeOptions(host))
    await vi.waitFor(() => {
      expect(postedTrailing(host).at(-1)).toEqual(['more'])
    })
    const before = postedTrailing(host).length

    await view.rerender(<Screen id="share" />)

    await vi.waitFor(() => {
      expect(postedTrailing(host).at(-1)).toEqual(['share'])
    })
    expect(postedTrailing(host).slice(before)).toEqual([['share']])
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
  it('moves the header row past the window controls', async () => {
    const host = createTestNativeChromeHost()
    const view = await renderInApp(<ChromeTopBar title={<h1>Tag</h1>} />, nativeChromeOptions(host))
    const left = (): number => view.container.querySelector('h1')!.getBoundingClientRect().left
    await vi.waitFor(() => {
      expect(host.posted).toContainEqual({ type: 'chromeReady' })
    })
    const start = left()

    host.sendIntent({ type: 'windowControls', width: 88 })
    await vi.waitFor(() => {
      expect(left()).toBeGreaterThanOrEqual(start + 88)
    })
    expect(document.documentElement.style.getPropertyValue('--window-controls-width')).toBe('88px')

    host.sendIntent({ type: 'windowControls', width: 0 })
    await vi.waitFor(() => {
      expect(left()).toBe(start)
    })
  })
})
