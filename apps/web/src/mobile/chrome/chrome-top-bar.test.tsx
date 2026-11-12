import type { ReactElement } from 'react'
import { createTestNativeChromeHost } from '@reflect/app/testing'
import { describe, expect, it, vi } from 'vitest'
import { ChromeLayerContext } from '@/mobile/chrome/chrome-renderer.ts'
import { ChromeTopBar } from '@/mobile/chrome/chrome-top-bar.tsx'
import { lastChromeState, nativeChromeOptions } from '@/test-utils/native-chrome.tsx'
import { renderInApp, type RenderInAppOptions } from '@/test-utils/render-in-app.tsx'

function bar(handlers: { back?: () => void; onAction?: (id: string) => void } = {}): ReactElement {
  return (
    <ChromeTopBar
      align="center"
      back={handlers.back ?? vi.fn()}
      trailing={[{ id: 'more', title: 'More actions', icon: 'ellipsis' }]}
      onAction={handlers.onAction ?? vi.fn()}
      title={<h1>Roadmap</h1>}
    />
  )
}

function rectOf(element: Element | null): DOMRect {
  if (element === null) {
    throw new Error('expected an element')
  }
  return element.getBoundingClientRect()
}

describe.each<[string, () => RenderInAppOptions]>([
  ['web', () => ({})],
  ['native', () => nativeChromeOptions(createTestNativeChromeHost())],
])('ChromeTopBar with the %s renderer', (_renderer, options) => {
  it('centers the title between balanced corners', async () => {
    const view = await renderInApp(bar(), options())

    const header = rectOf(view.container.querySelector('header'))
    const title = rectOf(view.container.querySelector('h1'))
    expect(title.left + title.width / 2).toBeCloseTo(header.left + header.width / 2, 1)

    const back = rectOf(view.container.querySelector('[aria-label="Back"]'))
    const more = rectOf(view.container.querySelector('[aria-label="More actions"]'))
    expect(back.left + back.width / 2 - header.left).toBeCloseTo(
      header.right - (more.left + more.width / 2),
      1,
    )
  })

  it('keeps the corners clear of an uneven side inset', async () => {
    document.documentElement.style.setProperty('--twsa-safe-area-inset-right', '84px')
    try {
      const view = await renderInApp(bar(), options())
      const header = rectOf(view.container.querySelector('header'))
      const more = rectOf(view.container.querySelector('[aria-label="More actions"]'))
      expect(more.right).toBeLessThanOrEqual(header.right - 84)
    } finally {
      document.documentElement.style.removeProperty('--twsa-safe-area-inset-right')
    }
  })
})

describe('ChromeTopBar', () => {
  it('draws the corner buttons with the web renderer', async () => {
    const back = vi.fn()
    const onAction = vi.fn()
    const view = await renderInApp(bar({ back, onAction }))

    await view.getByRole('button', { name: 'Back' }).click()
    await view.getByRole('button', { name: 'More actions' }).click()
    expect(back).toHaveBeenCalledOnce()
    expect(onAction).toHaveBeenCalledWith('more')
  })

  it('leaves the corner buttons to the shell with the native renderer', async () => {
    const host = createTestNativeChromeHost()
    const back = vi.fn()
    const onAction = vi.fn()
    const view = await renderInApp(bar({ back, onAction }), nativeChromeOptions(host))

    await vi.waitFor(() => {
      expect(lastChromeState(host)).toMatchObject({
        canBack: true,
        trailing: [{ id: 'more', title: 'More actions', icon: 'ellipsis' }],
      })
    })
    expect(view.getByRole('button', { name: 'Back' }).query()).toBeNull()
    const entryId = lastChromeState(host)?.entryId
    host.sendIntent({ type: 'back', entryId })
    host.sendIntent({ type: 'action', entryId, id: 'more' })
    expect(back).toHaveBeenCalledOnce()
    expect(onAction).toHaveBeenCalledWith('more')
  })

  it('registers no bar from a hidden stack layer and keeps a bar it does not own', async () => {
    // Three screens of one history entry: the later one owns its bar.
    const host = createTestNativeChromeHost()
    const header = (id: string): ReactElement => (
      <ChromeTopBar back={vi.fn()} trailing={[{ id, title: id }]} title={<h1>{id}</h1>} />
    )
    const screens = (withOlder: boolean): ReactElement => (
      <>
        {withOlder && header('older')}
        {header('top')}
        <ChromeLayerContext value={false}>{header('below')}</ChromeLayerContext>
      </>
    )
    const view = await renderInApp(screens(true), nativeChromeOptions(host))
    await vi.waitFor(() => {
      expect(lastChromeState(host)?.trailing.map((button) => button.id)).toEqual(['top'])
    })
    await view.rerender(screens(false))
    expect(lastChromeState(host)?.trailing.map((button) => button.id)).toEqual(['top'])
  })
})
