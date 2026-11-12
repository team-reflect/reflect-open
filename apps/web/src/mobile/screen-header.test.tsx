import type { ReactElement } from 'react'
import { createTestNativeChromeHost } from '@reflect/app/testing'
import { describe, expect, it, vi } from 'vitest'
import { ChromeLayerContext } from '@/mobile/chrome/chrome-renderer.ts'
import { lastChromeState, nativeChromeOptions } from '@/test-utils/native-chrome.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { MobileScreenHeader } from './screen-header.tsx'

describe('MobileScreenHeader', () => {
  it('centers the title between balanced header action slots', async () => {
    const view = await renderInApp(
      <MobileScreenHeader
        title="Roadmap"
        onBack={vi.fn()}
        trailing={<button type="button" aria-label="More actions" />}
      />,
    )

    const header = view.container.querySelector('header')
    if (header === null) {
      throw new Error('expected a header')
    }
    const bar = header.getBoundingClientRect()
    const title = view.getByRole('heading', { name: 'Roadmap' }).element().getBoundingClientRect()
    expect(title.left + title.width / 2).toBeCloseTo(bar.left + bar.width / 2, 1)

    const back = view.getByRole('button', { name: 'Back' }).element().getBoundingClientRect()
    const more = view
      .getByRole('button', { name: 'More actions' })
      .element()
      .getBoundingClientRect()
    expect(back.left + back.width / 2 - bar.left).toBeCloseTo(
      bar.right - (more.left + more.width / 2),
      1,
    )
  })

  it('keeps header actions clear of an uneven side inset', async () => {
    document.documentElement.style.setProperty('--twsa-safe-area-inset-right', '84px')
    try {
      const view = await renderInApp(
        <MobileScreenHeader
          title="Roadmap"
          onBack={vi.fn()}
          trailing={<button type="button" aria-label="More actions" />}
        />,
      )
      const header = view.container.querySelector('header')
      if (header === null) {
        throw new Error('expected a header')
      }
      const more = view.getByRole('button', { name: 'More actions' }).element()
      expect(more.getBoundingClientRect().right).toBeLessThanOrEqual(
        header.getBoundingClientRect().right - 84,
      )
    } finally {
      document.documentElement.style.removeProperty('--twsa-safe-area-inset-right')
    }
  })

  it('gives the native corner buttons their trailing buttons and back', async () => {
    const host = createTestNativeChromeHost()
    const onBack = vi.fn()
    const onNativeAction = vi.fn()
    await renderInApp(
      <MobileScreenHeader
        title="Roadmap"
        onBack={onBack}
        nativeTrailing={[{ id: 'more', title: 'More', icon: 'ellipsis' }]}
        onNativeAction={onNativeAction}
      />,
      nativeChromeOptions(host),
    )

    await vi.waitFor(() => {
      expect(lastChromeState(host)?.trailing).toEqual([
        { id: 'more', title: 'More', icon: 'ellipsis' },
      ])
    })
    const entryId = lastChromeState(host)?.entryId
    host.sendIntent({ type: 'back', entryId })
    host.sendIntent({ type: 'action', entryId, id: 'more' })
    expect(onBack).toHaveBeenCalledOnce()
    expect(onNativeAction).toHaveBeenCalledWith('more')
  })

  it('registers no bar from a hidden stack layer and keeps a bar it does not own', async () => {
    // Three screens of one history entry: the later one owns its bar.
    const host = createTestNativeChromeHost()
    const header = (id: string): ReactElement => (
      <MobileScreenHeader
        title={id}
        onBack={vi.fn()}
        nativeTrailing={[{ id, title: id }]}
        onNativeAction={vi.fn()}
      />
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
