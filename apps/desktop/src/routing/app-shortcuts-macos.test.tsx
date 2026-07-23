import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { renderHook } from 'vitest-browser-react'
import { PaletteProvider } from '@/components/command-palette/palette-provider'
import { registerAppCommands } from '@/lib/commands/app-commands'
import { dispatchMenuCommand } from '@/lib/native-menu/dispatch'
import { NoteTemplatesProvider } from '@/providers/note-templates-provider'
import { ShortcutsProvider } from '@/providers/shortcuts-provider'
import { SidebarProvider, useSidebar } from '@/providers/sidebar-provider'
import { useAppShortcuts } from './app-shortcuts'
import { RouterProvider } from './router'

// A browser-mode module mock materializes value exports once, so a live
// `get isMacosDesktop()` cannot flip per test the way it could under jsdom.
// The macOS-only behaviors live in this file with the flag statically true.
const nativeMenu = vi.hoisted(() => ({ installed: false }))

vi.mock('@/lib/platform', () => ({ isMacosDesktop: true }))
vi.mock('@/lib/native-menu/menu', () => ({
  isNativeMenuInstalled: () => nativeMenu.installed,
}))

vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    graph: { root: '/g', name: 'g', generation: 1 },
    recents: [],
    openRecent: vi.fn(),
  }),
}))
vi.mock('@/providers/theme-provider', () => ({
  useTheme: () => ({ theme: 'light', resolvedTheme: 'light', setTheme: vi.fn() }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: { editorMarkdownSyntax: 'hide', semanticSearchEnabled: false, theme: 'system' },
    updateSettings: vi.fn(),
  }),
}))
vi.mock('@/providers/audio-memo-provider', () => ({
  useAudioMemo: () => ({ toggle: vi.fn() }),
}))
vi.mock('@/providers/chat-provider', () => ({
  useChatSession: () => ({ newChat: vi.fn() }),
}))

registerAppCommands() // production does this in main.tsx

beforeEach(() => {
  nativeMenu.installed = false
})

function shortcutsHook() {
  return renderHook(
    () => {
      useAppShortcuts()
      return { sidebar: useSidebar() }
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <RouterProvider>
          <PaletteProvider>
            <ShortcutsProvider>
              <NoteTemplatesProvider>
                <SidebarProvider>{children}</SidebarProvider>
              </NoteTemplatesProvider>
            </ShortcutsProvider>
          </PaletteProvider>
        </RouterProvider>
      ),
    },
  )
}

describe('app shortcuts on macOS', () => {
  it('keeps the macOS webview fallback until the native menu is installed', async () => {
    const { result, act } = await shortcutsHook()
    const event = new KeyboardEvent('keydown', {
      key: '\\',
      metaKey: true,
      cancelable: true,
    })

    await act(() => {
      window.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
    expect(result.current.sidebar.collapsed).toBe(true)
  })

  it('leaves ⌘\\ to the native macOS menu accelerator', async () => {
    nativeMenu.installed = true
    const { result, act } = await shortcutsHook()
    const event = new KeyboardEvent('keydown', {
      key: '\\',
      metaKey: true,
      cancelable: true,
    })

    await act(() => {
      window.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(false)
    expect(result.current.sidebar.collapsed).toBe(false)

    await act(() => dispatchMenuCommand('sidebar.toggle'))
    expect(result.current.sidebar.collapsed).toBe(true)
  })
})
