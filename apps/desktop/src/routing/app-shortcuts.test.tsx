import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { PaletteProvider, usePalette } from '@/components/command-palette/palette-provider'
import { listRegisteredBindings } from '@/editor/keymap'
import { registerAppCommands } from '@/lib/commands/app-commands'
import { NoteTemplatesProvider } from '@/providers/note-templates-provider'
import { ShortcutsProvider, useShortcuts } from '@/providers/shortcuts-provider'
import { SidebarProvider } from '@/providers/sidebar-provider'
import { useAppShortcuts } from './app-shortcuts'
import { RouterProvider, useRouter } from './router'

const newChat = vi.hoisted(() => vi.fn())
const openRecent = vi.hoisted(() => vi.fn())

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

afterEach(() => {
  cleanup()
  openRecent.mockClear()
})

function shortcutsHook() {
  return renderHook(
    () => {
      useAppShortcuts()
      return { router: useRouter(), palette: usePalette(), shortcuts: useShortcuts() }
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
      'Mod-[',
      'Mod-]',
      'Mod-k',
      'Alt-Mod-l',
      'Meta-1',
      'Meta-9',
    ]) {
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

  it('⌘N from today makes back re-anchor Daily instead of restoring stale scroll', () => {
    const { result } = shortcutsHook()
    act(() => result.current.router.saveScrollState(735))
    expect(result.current.router.savedScroll()).toBe(735)

    act(() => press('n'))
    expect(result.current.router.route.kind).toBe('note')

    act(() => press('['))
    expect(result.current.router.route).toEqual({ kind: 'today' })
    expect(result.current.router.savedScroll()).toBeNull()
  })

  it('⌘[ and ⌘] still traverse when the focused editor consumes the keydown', () => {
    const { result } = shortcutsHook()
    act(() => press('n'))
    act(() => press('d'))
    expect(result.current.router.route).toEqual({ kind: 'today' })

    const editor = document.createElement('div')
    document.body.append(editor)
    editor.addEventListener('keydown', (event) => event.preventDefault())

    try {
      act(() => pressFrom(editor, 'Unidentified', { code: 'BracketLeft' }))
      expect(result.current.router.route.kind).toBe('note')

      act(() => pressFrom(editor, 'Unidentified', { code: 'BracketRight' }))
      expect(result.current.router.route).toEqual({ kind: 'today' })
    } finally {
      editor.remove()
    }
  })

  it('matches bracket history shortcuts by produced key on non-US layouts', () => {
    const { result } = shortcutsHook()
    act(() => press('n'))
    const opened = result.current.router.route
    act(() => press('d'))
    expect(result.current.router.route).toEqual({ kind: 'today' })

    // On JIS keyboards the key labeled `[` can report a physical BracketRight
    // code. The user-facing shortcut is character-based, so event.key wins.
    act(() => press('[', { code: 'BracketRight' }))
    expect(result.current.router.route).toEqual(opened)

    act(() => press(']', { code: 'BracketLeft' }))
    expect(result.current.router.route).toEqual({ kind: 'today' })
    expect(result.current.router.canForward).toBe(false)
  })

  it('⌘K opens the palette', () => {
    const { result } = shortcutsHook()
    expect(result.current.palette.open).toBe(false)
    act(() => press('k'))
    expect(result.current.palette.open).toBe(true)
  })

  it('defers ⌘K to a focused editor that already handled it', () => {
    const { result } = shortcutsHook()
    // The editor (meowdown's Mod-k) sits below window: it consumes the keydown
    // before it bubbles up, so the palette must stay closed.
    const editor = document.createElement('div')
    document.body.append(editor)
    editor.addEventListener('keydown', (event) => event.preventDefault())
    act(() => {
      editor.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true, bubbles: true }),
      )
    })
    expect(result.current.palette.open).toBe(false)
    editor.remove()
  })

  it('⌘⇧A opens All notes', () => {
    const { result } = shortcutsHook()

    act(() => press('a', { shiftKey: true }))
    expect(result.current.router.route).toEqual({ kind: 'allNotes', tag: null })
  })

  it('⌘⇧N starts a fresh chat when the chat route is active', () => {
    newChat.mockClear()
    const { result } = shortcutsHook()

    act(() => press('j'))
    expect(result.current.router.route).toEqual({ kind: 'chat' })

    act(() => press('n', { shiftKey: true }))
    expect(newChat).toHaveBeenCalledTimes(1)
  })

  it('⌘⇧N is inert outside the chat route', () => {
    newChat.mockClear()
    const { result } = shortcutsHook()

    act(() => press('n', { shiftKey: true }))
    expect(result.current.router.route).toEqual({ kind: 'today' })
    expect(newChat).not.toHaveBeenCalled()
  })

  it('⌘number switches to the matching recent graph', () => {
    shortcutsHook()

    act(() => press('1'))
    expect(openRecent).not.toHaveBeenCalled() // first row is already open

    act(() => press('2'))
    expect(openRecent).toHaveBeenCalledWith('/work')

    act(() => press('9'))
    expect(openRecent).toHaveBeenCalledTimes(1)
  })

  it('matches graph number shortcuts by physical digit key on symbol-producing layouts', () => {
    shortcutsHook()

    act(() => press('@', { code: 'Digit2' }))

    expect(openRecent).toHaveBeenCalledWith('/work')
  })

  it('strips Shift from physical digit fallback on layouts where digits require Shift', () => {
    shortcutsHook()

    act(() => press('2', { code: 'Digit2', shiftKey: true }))

    expect(openRecent).toHaveBeenCalledWith('/work')
  })

  it('does not turn produced symbols with Shift into graph number shortcuts', () => {
    shortcutsHook()

    act(() => press('@', { code: 'Digit2', shiftKey: true }))

    expect(openRecent).not.toHaveBeenCalled()
  })

  it('keeps graph switching on the Meta key, not Ctrl-number', () => {
    shortcutsHook()

    act(() => press('2', { metaKey: false, ctrlKey: true }))

    expect(openRecent).not.toHaveBeenCalled()
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

  it('⌘/ opens the cheat-sheet, closes it again, and mutes other shortcuts meanwhile', () => {
    const { result } = shortcutsHook()
    act(() => press('/'))
    expect(result.current.shortcuts.open).toBe(true)

    act(() => press('n'))
    expect(result.current.router.route).toEqual({ kind: 'today' }) // modal mutes navigation

    act(() => press('/'))
    expect(result.current.shortcuts.open).toBe(false)

    act(() => press('n'))
    expect(result.current.router.route.kind).toBe('note') // resumes after close
  })

  it('ignores chords with extra modifiers', () => {
    const { result } = shortcutsHook()
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'n', metaKey: true, altKey: true }),
      )
    })
    expect(result.current.router.route).toEqual({ kind: 'today' })
  })
})
