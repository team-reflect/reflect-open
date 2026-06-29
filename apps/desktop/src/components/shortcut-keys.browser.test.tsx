import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { ShortcutKeys } from './shortcut-keys'

const isApplePlatform = vi.hoisted(() => vi.fn(() => false))
vi.mock('@/lib/keybindings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/keybindings')>()),
  isApplePlatform,
}))

function keycapLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('kbd')].map((keycap) => keycap.textContent ?? '')
}

beforeEach(() => {
  isApplePlatform.mockReturnValue(false)
})

describe('ShortcutKeys', () => {
  it('renders Mod-k as command keycaps on Apple platforms', async () => {
    isApplePlatform.mockReturnValue(true)
    const view = await render(<ShortcutKeys binding="Mod-k" />)
    expect(keycapLabels(view.container)).toEqual(['⌘', 'K'])
  })

  it('renders Mod-k as Ctrl keycaps elsewhere', async () => {
    const view = await render(<ShortcutKeys binding="Mod-k" />)
    expect(keycapLabels(view.container)).toEqual(['Ctrl', 'K'])
  })

  it('renders one keycap per modifier with named-key symbols', async () => {
    isApplePlatform.mockReturnValue(true)
    const view = await render(<ShortcutKeys binding="Mod-Shift-Enter" />)
    expect(keycapLabels(view.container)).toEqual(['⌘', '⇧', '↩'])
  })

  it('groups all keys inside a single pill, V1-style', async () => {
    isApplePlatform.mockReturnValue(true)
    const view = await render(<ShortcutKeys binding="Mod-Shift-Enter" />)
    const pills = view.container.querySelectorAll(':scope > span')
    expect(pills).toHaveLength(1)
    expect(pills[0]?.querySelectorAll('kbd')).toHaveLength(3)
  })

  it('ghost mode renders the keys as plain joined text, not keycaps', async () => {
    isApplePlatform.mockReturnValue(true)
    const view = await render(<ShortcutKeys binding="Mod-k" ghost />)
    expect(keycapLabels(view.container)).toEqual([])
    expect(view.container.textContent).toBe('⌘K')
  })
})
