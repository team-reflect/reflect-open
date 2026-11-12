import type { ReactElement } from 'react'
import { createTestNativeChromeHost, createTestNativeChromeService } from '@reflect/app/testing'
import { describe, expect, it, vi } from 'vitest'
import {
  NativeBarLayerContext,
  nativeBarHandlers,
  nativeBars,
} from '@/mobile/native-chrome/registrations.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { MobileScreenHeader } from './screen-header.tsx'

/**
 * The app layer of a shell that draws the native chrome.
 */
function nativeChromeOptions() {
  return {
    appServices: { nativeChrome: createTestNativeChromeService(createTestNativeChromeHost()) },
  }
}

/**
 * The history entry of the only registered bar.
 */
function onlyBarEntry(): number {
  const entries = [...nativeBars.get().keys()]
  expect(entries).toHaveLength(1)
  return entries[0] ?? -1
}

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

  it('gives the native bar its title, trailing buttons, and back', async () => {
    const onBack = vi.fn()
    const onNativeAction = vi.fn()
    await renderInApp(
      <MobileScreenHeader
        title="Roadmap"
        onBack={onBack}
        nativeTrailing={[{ id: 'more', title: 'More', icon: 'ellipsis' }]}
        onNativeAction={onNativeAction}
      />,
      nativeChromeOptions(),
    )

    await vi.waitFor(() => {
      expect(nativeBars.get().get(onlyBarEntry())).toEqual({
        title: 'Roadmap',
        trailing: [{ id: 'more', title: 'More', icon: 'ellipsis' }],
      })
    })
    const entryId = onlyBarEntry()
    nativeBarHandlers(entryId)?.onBack?.()
    nativeBarHandlers(entryId)?.onAction('more')
    expect(onBack).toHaveBeenCalledOnce()
    expect(onNativeAction).toHaveBeenCalledWith('more')
  })

  it('registers no bar from a hidden stack layer and keeps a bar it does not own', async () => {
    // Three screens of one history entry: the later one owns its bar.
    const screens = (withOlder: boolean): ReactElement => (
      <>
        {withOlder && <MobileScreenHeader title="Older" onBack={vi.fn()} />}
        <MobileScreenHeader title="On top" onBack={vi.fn()} />
        <NativeBarLayerContext value={false}>
          <MobileScreenHeader title="Below" onBack={vi.fn()} />
        </NativeBarLayerContext>
      </>
    )
    const view = await renderInApp(screens(true), nativeChromeOptions())
    await vi.waitFor(() => {
      expect(nativeBars.get().get(onlyBarEntry())?.title).toBe('On top')
    })
    await view.rerender(screens(false))
    expect(nativeBars.get().get(onlyBarEntry())?.title).toBe('On top')
  })
})
