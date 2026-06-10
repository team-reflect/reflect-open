import { renderHook, act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { PaletteProvider, usePalette } from '@/components/command-palette/palette-provider'
import { listRegisteredBindings } from '@/editor/keymap'
import { registerAppCommands } from '@/lib/commands/app-commands'
import { SidebarProvider } from '@/providers/sidebar-provider'
import { useAppShortcuts } from './app-shortcuts'
import { RouterProvider, useRouter } from './router'

vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', cloudSync: null, generation: 1 } }),
}))
vi.mock('@/providers/theme-provider', () => ({
  useTheme: () => ({ theme: 'light', resolvedTheme: 'light', setTheme: vi.fn() }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: { editorMarkdownSyntax: 'focus', semanticSearchEnabled: false, theme: 'system' },
    updateSettings: vi.fn(),
  }),
}))

registerAppCommands() // production does this in main.tsx

function shortcutsHook() {
  return renderHook(
    () => {
      useAppShortcuts()
      return { router: useRouter(), palette: usePalette() }
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <RouterProvider>
          <PaletteProvider>
            <SidebarProvider>{children}</SidebarProvider>
          </PaletteProvider>
        </RouterProvider>
      ),
    },
  )
}

function press(key: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, cancelable: true }))
}

describe('app shortcuts', () => {
  it('registers the command keybindings in the central keymap registry', () => {
    const bindings = listRegisteredBindings()
    for (const key of ['Mod-d', 'Mod-n', 'Mod-[', 'Mod-]', 'Mod-k']) {
      expect(bindings.get(key)).toBe('app')
    }
  })

  it('⌘N opens a fresh note route; ⌘D returns to today; ⌘[ ⌘] traverse', () => {
    const { result } = shortcutsHook()

    act(() => press('n'))
    expect(result.current.router.route.kind).toBe('note')
    const opened = result.current.router.route as { kind: 'note'; path: string }
    expect(opened.path).toMatch(/^notes\/[0-9a-z]+\.md$/)

    act(() => press('d'))
    expect(result.current.router.route).toEqual({ kind: 'today' })

    act(() => press('['))
    expect(result.current.router.route.kind).toBe('note')

    act(() => press(']'))
    expect(result.current.router.route).toEqual({ kind: 'today' })
  })

  it('⌘K opens the palette', () => {
    const { result } = shortcutsHook()
    expect(result.current.palette.open).toBe(false)
    act(() => press('k'))
    expect(result.current.palette.open).toBe(true)
  })

  it('matches uppercase keys (caps lock) and ignores auto-repeat', () => {
    const { result } = shortcutsHook()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'N', metaKey: true }))
    })
    expect(result.current.router.route.kind).toBe('note') // caps lock still triggers

    const opened = result.current.router.route
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'n', metaKey: true, repeat: true }),
      )
    })
    expect(result.current.router.route).toEqual(opened) // held key doesn't spam notes
  })

  it('is inert while the palette is open (modal owns the keyboard)', () => {
    const { result } = shortcutsHook()
    act(() => result.current.palette.openPalette())
    act(() => press('n'))
    expect(result.current.router.route).toEqual({ kind: 'today' }) // nothing behind the overlay
    act(() => result.current.palette.closePalette())
    act(() => press('n'))
    expect(result.current.router.route.kind).toBe('note') // resumes after close
  })

  it('ignores chords with extra modifiers', () => {
    const { result } = shortcutsHook()
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'n', metaKey: true, shiftKey: true }),
      )
    })
    expect(result.current.router.route).toEqual({ kind: 'today' })
  })
})
