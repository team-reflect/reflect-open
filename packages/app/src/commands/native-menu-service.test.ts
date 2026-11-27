import { describe, expect, it, vi } from 'vitest'
import {
  createTestIpcBridgeService,
  createTestLoggerService,
  createTestPlatformService,
  type TestPlatformOptions,
} from '@reflect/core/testing'
import { createTestNativeMenuService } from '../testing/commands.ts'
import { createTestWindowService } from '../testing/window.ts'
import type { AppCommandId } from './app-commands.ts'
import { createCommandService } from './command-service.ts'
import type { AppSubmenuLayout, ContextMenuItem, NativeMenuItem } from './native-menu-service.ts'
import { returnNull } from '@ocavue/utils'

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

function setup(options?: {
  label?: string
  platform?: TestPlatformOptions
  failPaste?: boolean
  handled?: readonly AppCommandId[]
}) {
  const logger = createTestLoggerService()
  const commands = createCommandService({
    platform: createTestPlatformService(),
    logger: createTestLoggerService(),
  })
  // The commands that ran in this webview, in order.
  const ran: string[] = []
  const handlers = new AbortController()
  for (const id of options?.handled ?? ['sidebar.toggle', 'theme.toggle', 'note.find']) {
    commands.handle(id, () => void ran.push(id), handlers.signal)
  }
  const windows = createTestWindowService(
    options?.label !== undefined ? { label: options.label } : {},
  )
  const ipc = createTestIpcBridgeService({
    commands: options?.failPaste ? {} : { menu_install_paste_and_match_style: returnNull },
    logger,
  })
  const menu = createTestNativeMenuService({
    commands,
    window: windows,
    platform: createTestPlatformService(options?.platform),
    ipc,
    logger,
  })
  return { menu, commands, windows, ipc, logger, ran }
}

describe('install', () => {
  it('builds each submenu from the layout and the command registry', async () => {
    const { menu, ran } = setup({ platform: { isNativeShell: false } })

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
    expect(view?.nsAppRole).toBeUndefined()
    expect(windowMenu).toMatchObject({ text: 'Window', nsAppRole: 'windows' })

    const sidebarToggle = view?.items[0]
    if (sidebarToggle?.kind !== 'command') {
      throw new Error('expected a command item')
    }
    sidebarToggle.action('sidebar.toggle')
    expect(ran).toEqual(['sidebar.toggle'])
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
      menu.install([
        {
          text: 'File',
          entries: [{ kind: 'command', commandId: 'no.such' as AppCommandId }],
        },
      ]),
    ).rejects.toThrow('native menu references unknown command: no.such')
    expect(menu.isInstalled()).toBe(false)
  })
})

describe('menu command dispatch', () => {
  const event = 'reflect://menu-command'

  it('sends a menu action to the focused note window', async () => {
    const { menu, windows, ran } = setup()
    windows.setFocusedWindowLabel('note-1')

    menu.dispatchCommand('note.find')

    await vi.waitFor(() => {
      expect(windows.emitted()).toEqual([{ label: 'note-1', event, payload: 'note.find' }])
    })
    expect(ran).toEqual([])
  })

  it('runs a menu action in the main window when it has focus', async () => {
    const { menu, windows, ran } = setup()

    menu.dispatchCommand('note.find')

    await vi.waitFor(() => expect(ran).toEqual(['note.find']))
    expect(windows.emitted()).toEqual([])
  })

  it('does not guess the main window when no webview is focused', async () => {
    const { menu, windows, ran } = setup()
    windows.setFocusedWindowLabel(null)
    const focusedWindowLabel = vi.spyOn(windows, 'focusedWindowLabel')

    menu.dispatchCommand('note.find')

    await vi.waitFor(() => expect(focusedWindowLabel).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(windows.emitted()).toEqual([])
    expect(ran).toEqual([])
  })

  it('runs in place outside a native shell, and ignores undeclared ids', () => {
    const { menu, ran } = setup({ platform: { isNativeShell: false } })
    menu.dispatchCommand('note.find')
    menu.dispatchCommand('no.such.command')
    expect(ran).toEqual(['note.find'])
  })

  it('runs the commands that arrive in this webview', () => {
    const { menu, windows, ran } = setup({ label: 'note-1' })
    const unlisten = menu.connect()

    windows.emitWindowEvent(event, 'note.find')
    windows.emitWindowEvent(event, { command: 'note.find' })
    unlisten()
    windows.emitWindowEvent(event, 'note.find')

    expect(ran).toEqual(['note.find'])
    expect(windows.emitted()).toEqual([])
  })

  it('hands a command that a note window has no handler for to the main window', async () => {
    const { menu, windows, ran } = setup({ label: 'note-1', handled: ['history.back'] })
    menu.connect()

    windows.emitWindowEvent(event, 'history.back')
    windows.emitWindowEvent(event, 'note.new')

    expect(ran).toEqual(['history.back'])
    await vi.waitFor(() => {
      expect(windows.emitted()).toEqual([{ label: 'main', event, payload: 'note.new' }])
    })
  })

  it('keeps a blocked command in the note window', () => {
    const { menu, commands, windows, ran } = setup({ label: 'note-1', handled: ['history.back'] })
    menu.connect()
    commands.block([], new AbortController().signal)

    windows.emitWindowEvent(event, 'history.back')

    expect(ran).toEqual([])
    expect(windows.emitted()).toEqual([])
  })

  it('drops a command that the main window has no handler for', () => {
    const { menu, windows, ran } = setup({ handled: [] })
    menu.connect()

    windows.emitWindowEvent(event, 'note.new')

    expect(ran).toEqual([])
    expect(windows.emitted()).toEqual([])
  })
})

describe('openContextMenu', () => {
  it('opens the items as native menu items whose actions report the picked id', async () => {
    const { menu } = setup()
    const onSelect = vi.fn()
    const items: ContextMenuItem[] = [
      { type: 'action', id: 'complete', title: 'Complete' },
      { type: 'separator' },
      {
        type: 'submenu',
        title: 'Schedule',
        items: [
          { type: 'action', id: 'clear', title: 'Clear date', disabled: true, checked: false },
        ],
      },
    ]

    await menu.openContextMenu({ items, onSelect })

    const action = expect.any(Function) as (id: string) => void
    expect(menu.host.popups()).toEqual<NativeMenuItem[][]>([
      [
        { kind: 'command', text: 'Complete', enabled: true, action },
        { kind: 'predefined', item: 'Separator' },
        {
          kind: 'submenu',
          text: 'Schedule',
          items: [{ kind: 'command', text: 'Clear date', enabled: false, checked: false, action }],
        },
      ],
    ])
    expect(menu.popups()).toEqual([items])

    const [complete, , schedule] = menu.host.popups()[0] ?? []
    const clear = schedule?.kind === 'submenu' ? schedule.items[0] : undefined
    if (complete?.kind !== 'command' || clear?.kind !== 'command') {
      throw new Error('expected command items')
    }
    complete.action('')
    clear.action('')
    expect(onSelect.mock.calls).toEqual([['complete'], ['clear']])
  })
})
