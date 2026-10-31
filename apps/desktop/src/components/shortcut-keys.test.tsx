import { describe, expect, it } from 'vitest'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { ShortcutKeys } from './shortcut-keys.tsx'

function keycapLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('kbd')].map((keycap) => keycap.textContent ?? '')
}

describe('ShortcutKeys', () => {
  it('renders Mod-k as command keycaps on Apple platforms', async () => {
    const view = await renderInApp(<ShortcutKeys binding="Mod-k" />, {
      platform: { isApplePlatform: true },
    })
    expect(keycapLabels(view.container)).toEqual(['⌘', 'K'])
    await view.unmount()
  })

  it('renders Mod-k as Ctrl keycaps elsewhere', async () => {
    const view = await renderInApp(<ShortcutKeys binding="Mod-k" />, {
      platform: { isApplePlatform: false },
    })
    expect(keycapLabels(view.container)).toEqual(['Ctrl', 'K'])
    await view.unmount()
  })

  it('renders one keycap per modifier with named-key symbols', async () => {
    const view = await renderInApp(<ShortcutKeys binding="Mod-Shift-Enter" />, {
      platform: { isApplePlatform: true },
    })
    expect(keycapLabels(view.container)).toEqual(['⌘', '⇧', '↩'])
    await view.unmount()
  })

  it('groups all keys inside a single pill, V1-style', async () => {
    const view = await renderInApp(<ShortcutKeys binding="Mod-Shift-Enter" />, {
      platform: { isApplePlatform: true },
    })
    const pills = view.container.querySelectorAll(':scope > span')
    expect(pills).toHaveLength(1)
    expect(pills[0]?.querySelectorAll('kbd')).toHaveLength(3)
    await view.unmount()
  })

  it('ghost mode renders the keys as plain joined text, not keycaps', async () => {
    const view = await renderInApp(<ShortcutKeys binding="Mod-k" ghost />, {
      platform: { isApplePlatform: true },
    })
    expect(keycapLabels(view.container)).toEqual([])
    expect(view.container.textContent).toBe('⌘K')
    await view.unmount()
  })
})
