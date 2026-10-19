import { act } from '@/test-utils/act.ts'
import {
  isOstensiblyEmptyNoteSource,
  type ChatSession,
  type GraphSessionService,
  type NoteDocumentService,
} from '@reflect/core'
import type { AppServices, LinkNavigationService, NativeMenuService } from '@reflect/app'
import { createTestAppServices } from '@reflect/app/testing'
import {
  createTestCoreServices,
  createTestPlatformService,
  type TestCoreServices,
  type TestOpenGraph,
  type TestPlatformOptions,
} from '@reflect/core/testing'
import {
  FocusedDailyProvider,
  useSetFocusedDailyDate,
} from '@/providers/focused-daily-provider.tsx'
import { isModEvent } from '@meowdown/core'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { PaletteProvider, usePalette } from '@/components/command-palette/palette-provider.tsx'
import {
  registerNoteEditorHandle,
  unregisterNoteEditorHandle,
} from '@/editor/editor-handle-registry.ts'
import type { NoteEditorHandle } from '@/editor/note-editor.tsx'
import { registerAppKeymaps } from '@/lib/shortcuts.ts'
import { AudioMemoProvider } from '@/providers/audio-memo-provider.tsx'
import { NoteFindProvider, useNoteFind } from '@/providers/note-find-provider.tsx'
import { NoteTemplatesProvider } from '@/providers/note-templates-provider.tsx'
import { ShortcutsProvider, useShortcuts } from '@/providers/shortcuts-provider.tsx'
import { SidebarProvider, useSidebar } from '@/providers/sidebar-provider.tsx'
import { MOD_KEY, NON_MOD_KEY } from '@/test-utils/mod-key.ts'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useAppShortcuts } from './app-shortcuts.ts'
import { useRouter } from './router.tsx'

const GRAPH = { root: '/g', name: 'g', generation: 1 } satisfies TestOpenGraph

// `newChat` of the chat session the open graph created; set by `shortcutsHook`.
let newChat: MockInstance<ChatSession['newChat']>

/**
 * An editor handle that records the Find traversal and ignores the rest.
 */
function findHandle(findNext: () => void, findPrevious: () => void): NoteEditorHandle {
  return {
    getMarkdown: () => '',
    setMarkdown: () => {},
    insertMarkdown: () => {},
    focus: () => {},
    setSelection: () => {},
    getSelectedText: () => '',
    openSelectionMenu: () => {},
    startPendingReplacement: () => false,
    appendPendingReplacementText: () => {},
    acceptPendingReplacement: () => {},
    discardPendingReplacement: () => {},
    findNext,
    findPrevious,
  }
}

// What the app's note documents answer; reset before each test.
const commitNoteFrontmatter = vi.fn<NoteDocumentService['commitFrontmatter']>()

// The platform of the next `shortcutsHook`; each `describe` sets it.
let platform: TestPlatformOptions
// The services of the rendered app; set by `shortcutsHook`.
let app: TestCoreServices
let appLayer: AppServices
let openRecent: MockInstance<GraphSessionService['openRecent']>
let openRouteInNewWindow: MockInstance<LinkNavigationService['openRouteInNewWindow']>
let isNativeMenuInstalled: MockInstance<NativeMenuService['isInstalled']>

beforeEach(() => {
  platform = {
    isNativeShell: false,
    isMacosDesktop: false,
    isApplePlatform: MOD_KEY.metaKey,
    hasMacosTitleBarOverlay: false,
  }
  commitNoteFrontmatter.mockReset().mockResolvedValue(undefined)
})

async function shortcutsHook() {
  const readSource = (): Promise<string> => Promise.resolve('# A\n')
  const services = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    platform: createTestPlatformService(platform),
    noteDocuments: {
      readSource,
      readExisting: readSource,
      commitFrontmatter: commitNoteFrontmatter,
      commitSourceEdit: () => Promise.reject(new Error('commitSourceEdit is not stubbed')),
      isOstensiblyEmpty: isOstensiblyEmptyNoteSource,
    },
  })
  app = services
  appLayer = createTestAppServices(services)
  openRecent = vi.spyOn(services.graphSession, 'openRecent').mockResolvedValue(true)
  openRouteInNewWindow = vi
    .spyOn(appLayer.linkNavigation, 'openRouteInNewWindow')
    .mockResolvedValue(true)
  isNativeMenuInstalled = vi.spyOn(appLayer.nativeMenu, 'isInstalled').mockReturnValue(false)
  const createChatSession = services.chatSessions.create.bind(services.chatSessions)
  vi.spyOn(services.chatSessions, 'create').mockImplementation((options) => {
    const session = createChatSession(options)
    newChat = vi.spyOn(session, 'newChat')
    return session
  })
  return await renderHookInApp(
    () => {
      const context = useAppShortcuts()
      return {
        context,
        setFocusedDailyDate: useSetFocusedDailyDate(),
        router: useRouter(),
        palette: usePalette(),
        noteFind: useNoteFind(),
        shortcuts: useShortcuts(),
        sidebar: useSidebar(),
      }
    },
    {
      app: services,
      appServices: appLayer,
      graph: GRAPH,
      graphState: {
        recents: [
          { root: '/g', name: 'g', openedMs: 3 },
          { root: '/work', name: 'Work', openedMs: 2 },
          { root: '/side', name: 'Side', openedMs: 1 },
        ],
      },
      settings: { editorMarkdownSyntax: 'hide', semanticSearchEnabled: false, theme: 'system' },
      wrapper: (children) => (
        <PaletteProvider>
          <ShortcutsProvider>
            <NoteTemplatesProvider>
              <SidebarProvider>
                <FocusedDailyProvider>
                  <NoteFindProvider>
                    <AudioMemoProvider graph={GRAPH}>{children}</AudioMemoProvider>
                  </NoteFindProvider>
                </FocusedDailyProvider>
              </SidebarProvider>
            </NoteTemplatesProvider>
          </ShortcutsProvider>
        </PaletteProvider>
      ),
    },
  )
}

function press(key: string, options: KeyboardEventInit = {}) {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key, ...MOD_KEY, cancelable: true, ...options }),
  )
}

function pressFrom(target: EventTarget, key: string, options: KeyboardEventInit = {}) {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      ...MOD_KEY,
      cancelable: true,
      bubbles: true,
      ...options,
    }),
  )
}

describe('app shortcuts', () => {
  it('CMD+O updates the shelf before the file write resolves', async () => {
    const write = Promise.withResolvers<void>()
    commitNoteFrontmatter.mockReturnValueOnce(write.promise)
    const { result } = await shortcutsHook()
    await act(() => result.current.router.navigate({ kind: 'note', path: 'notes/a.md' }))
    await act(() => press('o'))
    await vi.waitFor(() => {
      expect(commitNoteFrontmatter).toHaveBeenCalledWith('notes/a.md', { pinned: 1024 }, 1)
    })
    expect(app.noteRows.getOverlay('notes/a.md')).toEqual({ isPinned: true, pinnedOrder: 1024 })
    await act(() => press('o'))
    expect(commitNoteFrontmatter).toHaveBeenCalledTimes(1)
    write.resolve()
    await act(async () => {
      await write.promise
    })
  })

  it('palette pin targets the focused daily note through the same context', async () => {
    const { result } = await shortcutsHook()
    await act(() => result.current.router.navigate({ kind: 'daily', date: '2026-09-08' }))
    await act(() => result.current.setFocusedDailyDate('2026-09-07'))
    await act(() => result.current.context.togglePin())
    expect(commitNoteFrontmatter).toHaveBeenCalledWith('daily/2026-09-07.md', { pinned: 1024 }, 1)
    expect(app.noteRows.getOverlay('daily/2026-09-07.md')).toMatchObject({ isPinned: true })
  })

  it('palette privacy updates the focused daily note row before the write resolves', async () => {
    const write = Promise.withResolvers<void>()
    commitNoteFrontmatter.mockReturnValueOnce(write.promise)
    const { result } = await shortcutsHook()
    await act(() => result.current.router.navigate({ kind: 'daily', date: '2026-09-08' }))
    await act(() => result.current.setFocusedDailyDate('2026-09-07'))
    const action = result.current.context.togglePrivate()
    await vi.waitFor(() => {
      expect(commitNoteFrontmatter).toHaveBeenCalledWith(
        'daily/2026-09-07.md',
        { private: true },
        1,
      )
    })
    expect(app.noteRows.getOverlay('daily/2026-09-07.md')).toEqual({ isPrivate: true })
    write.resolve()
    await action
  })

  it('pin and privacy no-op on note-less routes and without a graph', async () => {
    const { result } = await shortcutsHook()
    await act(() => result.current.router.navigate({ kind: 'settings' }))
    await act(() => press('o'))
    await act(() => result.current.context.togglePrivate())
    await act(() => app.graphSession.setGraph(null))
    await act(() => result.current.router.navigate({ kind: 'note', path: 'notes/a.md' }))
    await act(() => press('o'))
    await act(() => result.current.context.togglePrivate())
    expect(commitNoteFrontmatter).not.toHaveBeenCalled()
  })

  it('registers the command keybindings in the central keymap registry', () => {
    const { keymap } = createTestAppServices(
      createTestCoreServices({ database: createWasmTestDatabaseService() }),
    )
    registerAppKeymaps(keymap)
    const bindings = keymap.list()
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
      'Mod-1',
      'Mod-9',
    ]) {
      expect(bindings.get(key)).toBe('app')
    }
  })

  it('⌘N opens a fresh note route; ⌘D returns to today; ⌘[ ⌘] traverse', async () => {
    const { result } = await shortcutsHook()

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
    const { result } = await shortcutsHook()
    await act(() => result.current.router.saveScrollState(735))
    expect(result.current.router.savedScroll()).toBe(735)

    await act(() => press('n'))
    expect(result.current.router.route.kind).toBe('note')

    await act(() => press('['))
    expect(result.current.router.route).toEqual({ kind: 'today' })
    expect(result.current.router.savedScroll()).toBeNull()
  })

  it('⌘⇧O opens the current note in a new window', async () => {
    const { result } = await shortcutsHook()
    await act(() => press('n'))
    const opened = result.current.router.route

    await act(() => press('o', { shiftKey: true }))

    expect(openRouteInNewWindow).toHaveBeenCalledWith(opened)
    expect(result.current.router.route).toEqual(opened)
  })

  it('⌘[ and ⌘] still traverse when the focused editor consumes the keydown', async () => {
    const { result } = await shortcutsHook()
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
    const { result } = await shortcutsHook()
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
    const { result } = await shortcutsHook()
    expect(result.current.palette.open).toBe(false)
    await act(() => press('k'))
    expect(result.current.palette.open).toBe(true)
  })

  it('⌘F targets the current note and ⌘G traverses its matches', async () => {
    const { result } = await shortcutsHook()
    await act(() => press('n'))
    const opened = result.current.router.route
    if (opened.kind !== 'note') {
      throw new Error('expected the new-note route')
    }

    const findNext = vi.fn()
    const findPrevious = vi.fn()
    const handle = findHandle(findNext, findPrevious)
    registerNoteEditorHandle(opened.path, handle)

    expect(result.current.noteFind.open).toBe(false)
    await act(() => press('f'))
    expect(result.current.noteFind.open).toBe(true)

    await act(() => press('g'))
    expect(findNext).toHaveBeenCalledTimes(1)

    await act(() => press('g', { shiftKey: true }))
    expect(findPrevious).toHaveBeenCalledTimes(1)
    unregisterNoteEditorHandle(opened.path, handle)
  })

  it(String.raw`⌘\ toggles the sidebar in both directions`, async () => {
    const { result } = await shortcutsHook()
    expect(result.current.sidebar.collapsed).toBe(false)

    await act(() => press('\\'))
    expect(result.current.sidebar.collapsed).toBe(true)

    await act(() => press('\\'))
    expect(result.current.sidebar.collapsed).toBe(false)
  })

  it('defers ⌘K to a focused editor that already handled it', async () => {
    const { result } = await shortcutsHook()
    // The editor (meowdown's Mod-k) sits below window: it consumes the keydown
    // before it bubbles up, so the palette must stay closed.
    const editor = document.createElement('div')
    document.body.append(editor)
    editor.addEventListener('keydown', (event) => event.preventDefault())
    await act(() => {
      editor.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', ...MOD_KEY, cancelable: true, bubbles: true }),
      )
    })
    expect(result.current.palette.open).toBe(false)
    editor.remove()
  })

  it('⌘⇧A opens All notes', async () => {
    const { result } = await shortcutsHook()

    await act(() => press('a', { shiftKey: true }))
    expect(result.current.router.route).toEqual({ kind: 'allNotes', tag: null })
  })

  it('⌘⇧N starts a fresh chat when the chat route is active', async () => {
    const { result } = await shortcutsHook()

    await act(() => press('j'))
    expect(result.current.router.route).toEqual({ kind: 'chat' })

    await act(() => press('n', { shiftKey: true }))
    expect(newChat).toHaveBeenCalledTimes(1)
  })

  it('⌘⇧N is inert outside the chat route', async () => {
    const { result } = await shortcutsHook()

    await act(() => press('n', { shiftKey: true }))
    expect(result.current.router.route).toEqual({ kind: 'today' })
    expect(newChat).not.toHaveBeenCalled()
  })

  it('⌘number switches to the matching recent graph', async () => {
    await shortcutsHook()

    await act(() => press('1'))
    expect(openRecent).not.toHaveBeenCalled() // first row is already open

    await act(() => press('2'))
    expect(openRecent).toHaveBeenCalledWith('/work')

    await act(() => press('9'))
    expect(openRecent).toHaveBeenCalledTimes(1)
  })

  it('⌘number switches graphs from a focused editor that leaves the chord alone', async () => {
    await shortcutsHook()
    // Stands in for meowdown, whose heading toggles are ⌘⌥1–⌘⌥6: plain ⌘N is
    // not an editor binding, so the keydown bubbles to the app untouched.
    const toggleHeading = vi.fn()
    const editor = document.createElement('div')
    document.body.append(editor)
    editor.addEventListener('keydown', (event) => {
      if (event.altKey && isModEvent(event)) {
        toggleHeading()
        event.preventDefault()
      }
    })

    try {
      await act(() => pressFrom(editor, '2', { code: 'Digit2' }))
      expect(openRecent).toHaveBeenCalledWith('/work')
      expect(toggleHeading).not.toHaveBeenCalled()

      await act(() => pressFrom(editor, '™', { code: 'Digit2', altKey: true }))
      expect(openRecent).toHaveBeenCalledTimes(1) // ⌘⌥2 stays the editor's
      expect(toggleHeading).toHaveBeenCalledTimes(1)
    } finally {
      editor.remove()
    }
  })

  it('matches graph number shortcuts by physical digit key on symbol-producing layouts', async () => {
    await shortcutsHook()

    await act(() => press('@', { code: 'Digit2' }))

    expect(openRecent).toHaveBeenCalledWith('/work')
  })

  it('strips Shift from physical digit fallback on layouts where digits require Shift', async () => {
    await shortcutsHook()

    await act(() => press('2', { code: 'Digit2', shiftKey: true }))

    expect(openRecent).toHaveBeenCalledWith('/work')
  })

  it('does not turn produced symbols with Shift into graph number shortcuts', async () => {
    await shortcutsHook()

    await act(() => press('@', { code: 'Digit2', shiftKey: true }))

    expect(openRecent).not.toHaveBeenCalled()
  })

  it('switches graphs only on the Mod key, not the other command key', async () => {
    await shortcutsHook()

    await act(() => press('2', NON_MOD_KEY))

    expect(openRecent).not.toHaveBeenCalled()
  })

  it('matches uppercase keys (caps lock) and ignores auto-repeat', async () => {
    const { result } = await shortcutsHook()
    await act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'N', ...MOD_KEY }))
    })
    expect(result.current.router.route.kind).toBe('note') // caps lock still triggers

    const opened = result.current.router.route
    await act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ...MOD_KEY, repeat: true }))
    })
    expect(result.current.router.route).toEqual(opened) // held key doesn't spam notes
  })

  it('is inert while the palette is open (modal owns the keyboard)', async () => {
    const { result } = await shortcutsHook()
    await act(() => result.current.palette.openPalette())
    await act(() => press('n'))
    expect(result.current.router.route).toEqual({ kind: 'today' }) // nothing behind the overlay
    await act(() => result.current.palette.closePalette())
    await act(() => press('n'))
    expect(result.current.router.route.kind).toBe('note') // resumes after close
  })

  it('⌘/ opens the cheat-sheet, closes it again, and mutes other shortcuts meanwhile', async () => {
    const { result } = await shortcutsHook()
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
    const { result } = await shortcutsHook()
    await act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ...MOD_KEY, altKey: true }))
    })
    expect(result.current.router.route).toEqual({ kind: 'today' })
  })
})

describe('app shortcuts on macOS', () => {
  beforeEach(() => {
    platform = { isNativeShell: false }
  })

  it('keeps the macOS webview fallback until the native menu is installed', async () => {
    const { result } = await shortcutsHook()
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

  it(String.raw`leaves ⌘\ to the native macOS menu accelerator`, async () => {
    const { result } = await shortcutsHook()
    isNativeMenuInstalled.mockReturnValue(true)
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

    await act(() => appLayer.nativeMenu.dispatchCommand('sidebar.toggle'))
    expect(result.current.sidebar.collapsed).toBe(true)
  })
})
