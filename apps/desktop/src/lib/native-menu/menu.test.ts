import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface MenuItemOptionsForTest {
  readonly id?: string
  readonly text?: string
  readonly accelerator?: string
  readonly action?: (commandId: string) => void
}

interface SubmenuOptionsForTest {
  readonly text: string
  readonly items: readonly MenuItemOptionsForTest[]
}

const isTauri = vi.hoisted(() => vi.fn(() => true))
const isMainWindow = vi.hoisted(() => vi.fn(() => true))
const setAsAppMenu = vi.hoisted(() => vi.fn(async () => null))
const setAsWindowsMenuForNSApp = vi.hoisted(() => vi.fn(async () => {}))
const setAsHelpMenuForNSApp = vi.hoisted(() => vi.fn(async () => {}))
const submenuNew = vi.hoisted(() =>
  vi.fn(async (_options: SubmenuOptionsForTest) => ({
    setAsWindowsMenuForNSApp,
    setAsHelpMenuForNSApp,
  })),
)
const menuNew = vi.hoisted(() => vi.fn(async () => ({ setAsAppMenu })))

vi.mock('@tauri-apps/api/core', () => ({ isTauri }))
vi.mock('@tauri-apps/api/menu', () => ({
  Menu: { new: menuNew },
  Submenu: { new: submenuNew },
}))
vi.mock('@/lib/windows/window-role', () => ({ isMainWindow }))

const { APP_COMMANDS, keybindingFor } = await import('@/lib/commands/app-commands')
const { setMenuCommandDispatch } = await import('./dispatch')
const { appMenuLayout, installNativeMenu, isNativeMenuInstalled } = await import('./menu')

beforeEach(() => {
  vi.stubGlobal('navigator', { userAgent: 'Macintosh', maxTouchPoints: 0 })
  isTauri.mockReset().mockReturnValue(true)
  isMainWindow.mockReset().mockReturnValue(true)
  submenuNew.mockClear()
  menuNew.mockClear()
  setAsAppMenu.mockClear()
  setAsWindowsMenuForNSApp.mockClear()
  setAsHelpMenuForNSApp.mockClear()
})

afterEach(() => {
  setMenuCommandDispatch(null)
  vi.unstubAllGlobals()
})

function referencedCommandIds(): string[] {
  return appMenuLayout().flatMap((submenu) =>
    submenu.entries.flatMap((entry) => (entry.kind === 'command' ? [entry.commandId] : [])),
  )
}

describe('appMenuLayout', () => {
  it('references only registered command ids', () => {
    const known = new Set(APP_COMMANDS.map((appCommand) => appCommand.id))
    const referenced = referencedCommandIds()
    expect(referenced.length).toBeGreaterThan(0)
    for (const commandId of referenced) {
      expect(known).toContain(commandId)
    }
  })

  it('surfaces every ported V1 menu shortcut', () => {
    const referenced = new Set(referencedCommandIds())
    // The V1 Electron menu items that have a V2 command: Preferences ⌘,
    // New Note ⌘N, Search ⌘K, Select Daily Note ⌘D, All Notes ⌘⇧A,
    // Back ⌘[, Forward ⌘], Open Shortcuts ⌘/.
    for (const commandId of [
      'settings.open',
      'note.new',
      'palette.open',
      'nav.today',
      'nav.allNotes',
      'history.back',
      'history.forward',
      'shortcuts.show',
    ]) {
      expect(referenced).toContain(commandId)
    }
    expect(keybindingFor('nav.allNotes')).toBe('Mod-Shift-a')
  })

  it('lists each command at most once across the whole menu', () => {
    const referenced = referencedCommandIds()
    expect(new Set(referenced).size).toBe(referenced.length)
  })

  it('exposes the selected note’s new-window shortcut in the native Window menu', () => {
    const windowMenu = appMenuLayout().find((submenu) => submenu.text === 'Window')
    expect(windowMenu?.entries).toContainEqual({
      kind: 'command',
      commandId: 'note.openInNewWindow',
      text: undefined,
    })
    expect(keybindingFor('note.openInNewWindow')).toBe('Mod-Shift-o')
  })
})

describe('installNativeMenu', () => {
  it('installs sidebar.toggle as a native Command+\\ menu accelerator', async () => {
    const dispatch = vi.fn()
    setMenuCommandDispatch(dispatch)

    await installNativeMenu()

    const viewMenu = submenuNew.mock.calls
      .map(([options]) => options)
      .find((options) => options.text === 'View')
    const sidebarToggle = viewMenu?.items.find((item) => item.id === 'sidebar.toggle')

    expect(sidebarToggle).toMatchObject({
      id: 'sidebar.toggle',
      text: 'Toggle sidebar',
      accelerator: 'CmdOrCtrl+\\',
    })
    expect(sidebarToggle?.action).toBeTypeOf('function')
    sidebarToggle?.action?.('sidebar.toggle')
    expect(dispatch).toHaveBeenCalledWith('sidebar.toggle')
    expect(menuNew).toHaveBeenCalledTimes(1)
    expect(setAsAppMenu).toHaveBeenCalledTimes(1)
    expect(isNativeMenuInstalled()).toBe(true)
  })

  it('leaves the main window’s app-wide menu intact when a note window boots', async () => {
    isMainWindow.mockReturnValue(false)

    await installNativeMenu()

    expect(isMainWindow).toHaveBeenCalledTimes(1)
    expect(submenuNew).not.toHaveBeenCalled()
    expect(menuNew).not.toHaveBeenCalled()
  })
})
