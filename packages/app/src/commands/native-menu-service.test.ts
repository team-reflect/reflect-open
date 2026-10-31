import { describe, expect, it, vi } from 'vitest'
import {
  createTestIpcBridgeService,
  createTestLoggerService,
  createTestPlatformService,
  type TestPlatformOptions,
} from '@reflect/core/testing'
import { createTestNativeMenuService } from '../testing/commands.ts'
import { createTestWindowService } from '../testing/window.ts'
import { createCommandService } from './command-service.ts'
import type { AppSubmenuLayout, NativeMenuItem } from './native-menu-service.ts'

const LAYOUT: AppSubmenuLayout[] = [
  {
    text: 'View',
    entries: [
      { kind: 'command', commandId: 'sidebar.toggle' },
      { kind: 'predefined', item: 'Separator' },
      { kind: 'command', commandId: 'theme.toggle', text: 'Switch theme' },
      { kind: 'predefined', item: 'Quit', text: 'Quit Reflect' },
    ],
  },
  { text: 'Window', nsAppRole: 'windows', entries: [{ kind: 'predefined', item: 'Minimize' }] },
]

function setup(options?: { label?: string; platform?: TestPlatformOptions; failPaste?: boolean }) {
  const logger = createTestLoggerService()
  const commands = createCommandService({
    platform: createTestPlatformService(),
    logger: createTestLoggerService(),
  })
  commands.register([
    { id: 'sidebar.toggle', title: 'Toggle sidebar', keybinding: 'Mod-\\', run: () => {} },
    { id: 'theme.toggle', title: 'Toggle theme', run: () => {} },
  ])
  const windows = createTestWindowService(
    options?.label !== undefined ? { label: options.label } : {},
  )
  const ipc = createTestIpcBridgeService({
    commands: options?.failPaste ? {} : { menu_install_paste_and_match_style: () => null },
    logger,
  })
  const menu = createTestNativeMenuService({
    commands,
    window: windows,
    platform: createTestPlatformService(options?.platform),
    ipc,
    logger,
  })
  return { menu, windows, ipc, logger }
}

describe('install', () => {
  it('builds each submenu from the layout and the command registry', async () => {
    const { menu } = setup()
    const dispatch = vi.fn()
    menu.setCommandDispatch(dispatch)

    await menu.install(LAYOUT)

    const [view, windowMenu] = menu.host.appMenu() ?? []
    expect(view?.items).toEqual<NativeMenuItem[]>([
      {
        kind: 'command',
        id: 'sidebar.toggle',
        text: 'Toggle sidebar',
        accelerator: 'CmdOrCtrl+\\',
        action: menu.dispatchCommand,
      },
      { kind: 'predefined', item: 'Separator' },
      { kind: 'command', id: 'theme.toggle', text: 'Switch theme', action: menu.dispatchCommand },
      { kind: 'predefined', item: 'Quit', text: 'Quit Reflect' },
    ])
    expect(view).not.toHaveProperty('nsAppRole')
    expect(windowMenu).toMatchObject({ text: 'Window', nsAppRole: 'windows' })

    const sidebarToggle = view?.items[0]
    if (sidebarToggle?.kind !== 'command') {
      throw new Error('expected a command item')
    }
    sidebarToggle.action('sidebar.toggle')
    expect(dispatch).toHaveBeenCalledWith('sidebar.toggle')
    expect(menu.isInstalled()).toBe(true)
  })

  it('adds Paste and Match Style after the menu is installed and its roles are assigned', async () => {
    const { menu, ipc } = setup()
    let hostCallsAtPaste: readonly string[] = []
    ipc.onCommand('menu_install_paste_and_match_style', () => {
      hostCallsAtPaste = [...menu.host.calls]
      return null
    })

    await menu.install(LAYOUT)

    expect(hostCallsAtPaste).toEqual(['buildAppMenu', 'setAsAppMenu', 'assignNsAppRoles'])
    expect(ipc.calls()).toEqual([{ command: 'menu_install_paste_and_match_style', args: {} }])
  })

  it('stays installed when Paste and Match Style cannot be added', async () => {
    const { menu, logger } = setup({ failPaste: true })

    await expect(menu.install(LAYOUT)).resolves.toBeUndefined()

    expect(menu.isInstalled()).toBe(true)
    expect(logger.getWarnings().map((entry) => entry.message)).toEqual([
      'failed to add the Paste and Match Style menu item:',
    ])
  })

  it('leaves the main window’s app-wide menu intact when a note window boots', async () => {
    const { menu, ipc } = setup({ label: 'note-1' })

    await menu.install(LAYOUT)

    expect(menu.host.calls).toEqual([])
    expect(ipc.calls()).toEqual([])
    expect(menu.isInstalled()).toBe(false)
  })

  it('installs nothing off the macOS desktop', async () => {
    const { menu } = setup({ platform: { isMacosDesktop: false } })

    await menu.install(LAYOUT)

    expect(menu.host.calls).toEqual([])
    expect(menu.isInstalled()).toBe(false)
  })

  it('rejects a layout that references an unknown command', async () => {
    const { menu } = setup()

    await expect(
      menu.install([{ text: 'File', entries: [{ kind: 'command', commandId: 'note.new' }] }]),
    ).rejects.toThrow('native menu references unknown command: note.new')
    expect(menu.isInstalled()).toBe(false)
  })
})

describe('focused note menu dispatch', () => {
  const event = 'reflect://focused-note-menu-command'

  it('routes Find menu actions to the focused secondary note window', async () => {
    const { menu, windows } = setup()
    const dispatch = vi.fn()
    menu.setCommandDispatch(dispatch)
    windows.setFocusedWindowLabel('note-1')

    menu.dispatchCommand('note.find')

    await vi.waitFor(() => {
      expect(windows.emitted()).toEqual([{ label: 'note-1', event, payload: 'note.find' }])
    })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('runs Find menu actions in the main window when it has focus', async () => {
    const { menu, windows } = setup()
    const dispatch = vi.fn()
    menu.setCommandDispatch(dispatch)

    menu.dispatchCommand('note.findNext')

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith('note.findNext'))
    expect(windows.emitted()).toEqual([])
  })

  it('does not guess the main note when no webview is focused', async () => {
    const { menu, windows } = setup()
    const dispatch = vi.fn()
    menu.setCommandDispatch(dispatch)
    windows.setFocusedWindowLabel(null)
    const focusedWindowLabel = vi.spyOn(windows, 'focusedWindowLabel')

    menu.dispatchCommand('note.find')

    await vi.waitFor(() => expect(focusedWindowLabel).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(windows.emitted()).toEqual([])
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('sends every other command, and Find outside a native shell, to the dispatcher', () => {
    const { menu } = setup()
    const dispatch = vi.fn()
    menu.setCommandDispatch(dispatch)
    menu.dispatchCommand('sidebar.toggle')
    expect(dispatch).toHaveBeenLastCalledWith('sidebar.toggle')

    const browser = setup({ platform: { isNativeShell: false } })
    browser.menu.setCommandDispatch(dispatch)
    browser.menu.dispatchCommand('note.find')
    expect(dispatch).toHaveBeenLastCalledWith('note.find')

    menu.setCommandDispatch(null)
    menu.dispatchCommand('sidebar.toggle')
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('validates routed Find menu event payloads before dispatching them', () => {
    const { menu, windows } = setup()
    const dispatch = vi.fn()
    const unlisten = menu.subscribeFocusedNoteCommands(dispatch)

    windows.emitWindowEvent(event, 'note.findNext')
    windows.emitWindowEvent(event, { command: 'note.findNext' })
    unlisten()
    windows.emitWindowEvent(event, 'note.find')

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith('note.findNext')
  })
})

describe('openContextMenu', () => {
  it('does nothing outside a native shell', async () => {
    const { menu } = setup({ platform: { isNativeShell: false } })
    const onSelect = vi.fn()

    await menu.openContextMenu({ items: [{ text: 'Unpin Note', action: onSelect }] })

    expect(menu.host.popups()).toEqual([])
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('opens a native menu whose items run their actions', async () => {
    const { menu } = setup()
    const onSelect = vi.fn()

    await menu.openContextMenu({ items: [{ text: 'Unpin Note', action: onSelect }] })

    expect(menu.host.popups()).toEqual([[{ text: 'Unpin Note', action: onSelect }]])
    menu.host.popups()[0]?.[0]?.action()
    expect(onSelect).toHaveBeenCalled()
  })
})
