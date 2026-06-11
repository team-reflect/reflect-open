import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  it('renders Mod-k as command keycaps on Apple platforms', () => {
    isApplePlatform.mockReturnValue(true)
    const view = render(<ShortcutKeys binding="Mod-k" />)
    expect(keycapLabels(view.container)).toEqual(['⌘', 'K'])
    view.unmount()
  })

  it('renders Mod-k as Ctrl keycaps elsewhere', () => {
    const view = render(<ShortcutKeys binding="Mod-k" />)
    expect(keycapLabels(view.container)).toEqual(['Ctrl', 'K'])
    view.unmount()
  })

  it('renders one keycap per modifier with named-key symbols', () => {
    isApplePlatform.mockReturnValue(true)
    const view = render(<ShortcutKeys binding="Mod-Shift-Enter" />)
    expect(keycapLabels(view.container)).toEqual(['⌘', '⇧', '↩'])
    view.unmount()
  })

  it('ghost mode renders the keys as plain joined text, not keycaps', () => {
    isApplePlatform.mockReturnValue(true)
    const view = render(<ShortcutKeys binding="Mod-k" ghost />)
    expect(keycapLabels(view.container)).toEqual([])
    expect(view.container.textContent).toBe('⌘K')
    view.unmount()
  })
})
