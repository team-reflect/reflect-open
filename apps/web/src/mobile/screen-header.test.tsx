import type { ReactElement } from 'react'
import { createTestNativeChromeHost } from '@reflect/app/testing'
import { describe, expect, it, vi } from 'vitest'
import { ChromeLayerContext } from '@/mobile/chrome/chrome-renderer.ts'
import { lastChromeState, nativeChromeOptions } from '@/test-utils/native-chrome.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { MobileScreenHeader } from './screen-header.tsx'

describe('MobileScreenHeader', () => {
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
