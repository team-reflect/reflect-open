import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import {
  NativeBarLayerContext,
  nativeBarHandlers,
  nativeBars,
} from '@/mobile/native-chrome/registrations.ts'
import { installNativeChrome } from '@/services/native-chrome-transport.ts'
import { MobileScreenHeader } from './screen-header.tsx'

describe('MobileScreenHeader', () => {
  it('centers the title between balanced header action slots', async () => {
    const view = await render(
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
      const view = await render(
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
    const handler = { postMessage: vi.fn() }
    installNativeChrome(
      {
        __nativeChromeFeatures: ['tabbar', 'navbar'],
        webkit: { messageHandlers: { reflectHost: handler, reflectChrome: handler } },
      },
      document.documentElement,
    )
    try {
      const onBack = vi.fn()
      const onNativeAction = vi.fn()
      await render(
        <MobileScreenHeader
          title="Roadmap"
          onBack={onBack}
          nativeTrailing={[{ id: 'more', title: 'More', icon: 'ellipsis' }]}
          onNativeAction={onNativeAction}
        />,
      )

      await vi.waitFor(() => {
        expect(nativeBars.get().get(0)).toEqual({
          title: 'Roadmap',
          trailing: [{ id: 'more', title: 'More', icon: 'ellipsis' }],
        })
      })
      nativeBarHandlers(0)?.onBack?.()
      nativeBarHandlers(0)?.onAction('more')
      expect(onBack).toHaveBeenCalledOnce()
      expect(onNativeAction).toHaveBeenCalledWith('more')
    } finally {
      installNativeChrome({}, document.documentElement)
    }
  })

  it('registers no bar from a hidden stack layer and keeps a bar it does not own', async () => {
    const handler = { postMessage: vi.fn() }
    installNativeChrome(
      {
        __nativeChromeFeatures: ['tabbar', 'navbar'],
        webkit: { messageHandlers: { reflectHost: handler, reflectChrome: handler } },
      },
      document.documentElement,
    )
    try {
      const older = await render(<MobileScreenHeader title="Older" onBack={vi.fn()} />)
      await render(<MobileScreenHeader title="On top" onBack={vi.fn()} />)
      await render(
        <NativeBarLayerContext value={false}>
          <MobileScreenHeader title="Below" onBack={vi.fn()} />
        </NativeBarLayerContext>,
      )
      await vi.waitFor(() => {
        expect(nativeBars.get().get(0)?.title).toBe('On top')
      })
      await older.unmount()
      expect(nativeBars.get().get(0)?.title).toBe('On top')
    } finally {
      installNativeChrome({}, document.documentElement)
    }
  })
})
