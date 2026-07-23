import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { renderHook } from 'vitest-browser-react'
import { PaletteProvider, usePalette } from '@/components/command-palette/palette-provider'
import { listRegisteredBindings } from '@/editor/keymap'
import { registerAppCommands } from '@/lib/commands/app-commands'
import { NoteTemplatesProvider } from '@/providers/note-templates-provider'
import { ShortcutsProvider, useShortcuts } from '@/providers/shortcuts-provider'
import { SidebarProvider, useSidebar } from '@/providers/sidebar-provider'
import { useAppShortcuts } from './app-shortcuts'
import { RouterProvider, useRouter } from './router'

const newChat = vi.hoisted(() => vi.fn())
const openRecent = vi.hoisted(() => vi.fn())
const openRouteInNewWindow = vi.hoisted(() => vi.fn(async () => true))

vi.mock('@/lib/windows/open-in-new-window', () => ({ openRouteInNewWindow }))
vi.mock('@/lib/native-menu/menu', () => ({
  isNativeMenuInstalled: () => false,
}))
// macOS-only shortcut behavior lives in app-shortcuts-macos.test.tsx: a
// browser-mode module mock materializes value exports once, so the flag
// cannot flip per test.
vi.mock('@/lib/platform', () => ({ isMacosDesktop: false }))

vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    graph: { root: '/g', name: 'g', generation: 1 },
    recents: [
      { root: '/g', name: 'g', openedMs: 3 },
      { root: '/work', name: 'Work', openedMs: 2 },
      { root: '/side', name: 'Side', openedMs: 1 },
    ],
    openRecent,
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
  useChatSession: () => ({ newChat }),
}))

registerAppCommands() // production does this in main.tsx

beforeEach(() => {
  openRecent.mockClear()
  openRouteInNewWindow.mockClear()
})

function shortcutsHook() {
  return renderHook(
    () => {
      useAppShortcuts()
      return {
        router: useRouter(),
        palette: usePalette(),
        shortcuts: useShortcuts(),
        sidebar: useSidebar(),
      }
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

function press(key: string, options: KeyboardEventInit = {}) {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key, metaKey: true, cancelable: true, ...options }),
  )
}

function pressFrom(target: EventTarget, key: string, options: KeyboardEventInit = {}) {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      metaKey: true,
      cancelable: true,
      bubbles: true,
      ...options,
    }),
  )
}

describe('app shortcuts', () => {
  it('registers the command keybindings in the central keymap registry', () => {
    const bindings = listRegisteredBindings()
    for (const key of [
      'Mod-d',
      'Mod-Shift-a',
      'Mod-n',
      'Mod-Shift-n',
      'Mod-Shift-o',
      'Mod-[',
      'Mod-]',
      'Mod-k',
      'Mod-\\',
      'Alt-Mod-l',
      'Meta-1',
      'Meta-9',
    ]) {
      expect(bindings.get(key)).toBe('app')
    }
  })

  it('⌘N opens a fresh note route; ⌘D returns to today; ⌘[ ⌘] traverse', async () => {
    const { result, act } = await shortcutsHook()

    await act(() => press('n'))
    expect(result.current.router.route.kind).toBe('note')
    const opened = result.current.router.route as { kind: 'note'; path: string }
    expect(opened.path).toMatch(/^notes\/[0-9a-z]+\.md$/)

    await act(() => press('d'))
    expect(result.current.router.route).toEqual({ kind: 'today' })

    await act(() => press('['))
    expect(result.current.router.route.kind).toBe('note')

    await act(() => press(']'))
    expect(result.current.router.route).toEqual({ kind: 'today' })
  })

  it('⌘N from today makes back re-anchor Daily instead of restoring stale scroll', async () => {
    const { result, act } = await shortcutsHook()
    await act(() => result.current.router.saveScrollState(735))
    expect(result.current.router.savedScroll()).toBe(735)

    await act(() => press('n'))
    expect(result.current.router.route.kind).toBe('note')

    await act(() => press('['))
    expect(result.current.router.route).toEqual({ kind: 'today' })
    expect(result.current.router.savedScroll()).toBeNull()
  })

  it('⌘⇧O opens the current note in a new window', async () => {
    const { result, act } = await shortcutsHook()
    await act(() => press('n'))
    const opened = result.current.router.route

    await act(() => press('o', { shiftKey: true }))

    expect(openRouteInNewWindow).toHaveBeenCalledWith(opened)
    expect(result.current.router.route).toEqual(opened)
  })

  it('⌘[ and ⌘] still traverse when the focused editor consumes the keydown', async () => {
    const { result, act } = await shortcutsHook()
    await act(() => press('n'))
    await act(() => press('d'))
    expect(result.current.router.route).toEqual({ kind: 'today' })

    const editor = document.createElement('div')
    document.body.append(editor)
    editor.addEventListener('keydown', (event) => event.preventDefault())

    try {
      await act(() => pressFrom(editor, 'Unidentified', { code: 'BracketLeft' }))
      expect(result.current.router.route.kind).toBe('note')

      await act(() => pressFrom(editor, 'Unidentified', { code: 'BracketRight' }))
      expect(result.current.router.route).toEqual({ kind: 'today' })
    } finally {
      editor.remove()
    }
  })

  it('matches bracket history shortcuts by produced key on non-US layouts', async () => {
    const { result, act } = await shortcutsHook()
    await act(() => press('n'))
    const opened = result.current.router.route
    await act(() => press('d'))
    expect(result.current.router.route).toEqual({ kind: 'today' })

    // On JIS keyboards the key labeled `[` can report a physical BracketRight
    // code. The user-facing shortcut is character-based, so event.key wins.
    await act(() => press('[', { code: 'BracketRight' }))
    expect(result.current.router.route).toEqual(opened)

    await act(() => press(']', { code: 'BracketLeft' }))
    expect(result.current.router.route).toEqual({ kind: 'today' })
    expect(result.current.router.canForward).toBe(false)
  })

  it('⌘K opens the palette', async () => {
    const { result, act } = await shortcutsHook()
    expect(result.current.palette.open).toBe(false)
    await act(() => press('k'))
    expect(result.current.palette.open).toBe(true)
  })

  it('⌘\\ toggles the sidebar in both directions', async () => {
    const { result, act } = await shortcutsHook()
    expect(result.current.sidebar.collapsed).toBe(false)

    await act(() => press('\\'))
    expect(result.current.sidebar.collapsed).toBe(true)

    await act(() => press('\\'))
    expect(result.current.sidebar.collapsed).toBe(false)
  })

  it('defers ⌘K to a focused editor that already handled it', async () => {
    const { result, act } = await shortcutsHook()
    // The editor (meowdown's Mod-k) sits below window: it consumes the keydown
    // before it bubbles up, so the palette must stay closed.
    const editor = document.createElement('div')
    document.body.append(editor)
    editor.addEventListener('keydown', (event) => event.preventDefault())
    await act(() => {
      editor.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true, bubbles: true }),
      )
    })
    expect(result.current.palette.open).toBe(false)
    editor.remove()
  })

  it('⌘⇧A opens All notes', async () => {
    const { result, act } = await shortcutsHook()

    await act(() => press('a', { shiftKey: true }))
    expect(result.current.router.route).toEqual({ kind: 'allNotes', tag: null })
  })

  it('⌘⇧N starts a fresh chat when the chat route is active', async () => {
    newChat.mockClear()
    const { result, act } = await shortcutsHook()

    await act(() => press('j'))
    expect(result.current.router.route).toEqual({ kind: 'chat' })

    await act(() => press('n', { shiftKey: true }))
    expect(newChat).toHaveBeenCalledTimes(1)
  })

  it('⌘⇧N is inert outside the chat route', async () => {
    newChat.mockClear()
    const { result, act } = await shortcutsHook()

    await act(() => press('n', { shiftKey: true }))
    expect(result.current.router.route).toEqual({ kind: 'today' })
    expect(newChat).not.toHaveBeenCalled()
  })

  it('⌘number switches to the matching recent graph', async () => {
    const { act } = await shortcutsHook()

    await act(() => press('1'))
    expect(openRecent).not.toHaveBeenCalled() // first row is already open

    await act(() => press('2'))
    expect(openRecent).toHaveBeenCalledWith('/work')

    await act(() => press('9'))
    expect(openRecent).toHaveBeenCalledTimes(1)
  })

  it('matches graph number shortcuts by physical digit key on symbol-producing layouts', async () => {
    const { act } = await shortcutsHook()

    await act(() => press('@', { code: 'Digit2' }))

    expect(openRecent).toHaveBeenCalledWith('/work')
  })

  it('strips Shift from physical digit fallback on layouts where digits require Shift', async () => {
    const { act } = await shortcutsHook()

    await act(() => press('2', { code: 'Digit2', shiftKey: true }))

    expect(openRecent).toHaveBeenCalledWith('/work')
  })

  it('does not turn produced symbols with Shift into graph number shortcuts', async () => {
    const { act } = await shortcutsHook()

    await act(() => press('@', { code: 'Digit2', shiftKey: true }))

    expect(openRecent).not.toHaveBeenCalled()
  })

  it('keeps graph switching on the Meta key, not Ctrl-number', async () => {
    const { act } = await shortcutsHook()

    await act(() => press('2', { metaKey: false, ctrlKey: true }))

    expect(openRecent).not.toHaveBeenCalled()
  })

  it('matches uppercase keys (caps lock) and ignores auto-repeat', async () => {
    const { result, act } = await shortcutsHook()
    await act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'N', metaKey: true }))
    })
    expect(result.current.router.route.kind).toBe('note') // caps lock still triggers

    const opened = result.current.router.route
    await act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'n', metaKey: true, repeat: true }),
      )
    })
    expect(result.current.router.route).toEqual(opened) // held key doesn't spam notes
  })

  it('is inert while the palette is open (modal owns the keyboard)', async () => {
    const { result, act } = await shortcutsHook()
    await act(() => result.current.palette.openPalette())
    await act(() => press('n'))
    expect(result.current.router.route).toEqual({ kind: 'today' }) // nothing behind the overlay
    await act(() => result.current.palette.closePalette())
    await act(() => press('n'))
    expect(result.current.router.route.kind).toBe('note') // resumes after close
  })

  it('⌘/ opens the cheat-sheet, closes it again, and mutes other shortcuts meanwhile', async () => {
    const { result, act } = await shortcutsHook()
    await act(() => press('/'))
    expect(result.current.shortcuts.open).toBe(true)

    await act(() => press('n'))
    expect(result.current.router.route).toEqual({ kind: 'today' }) // modal mutes navigation

    await act(() => press('/'))
    expect(result.current.shortcuts.open).toBe(false)

    await act(() => press('n'))
    expect(result.current.router.route.kind).toBe('note') // resumes after close
  })

  it('ignores chords with extra modifiers', async () => {
    const { result, act } = await shortcutsHook()
    await act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'n', metaKey: true, altKey: true }),
      )
    })
    expect(result.current.router.route).toEqual({ kind: 'today' })
  })
})
