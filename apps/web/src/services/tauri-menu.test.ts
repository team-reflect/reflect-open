import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContextMenuItem, NativeSubmenu } from '@reflect/app'

const calls = vi.hoisted((): string[] => [])
const closed = vi.hoisted((): string[] => [])
const popup = vi.hoisted(() => vi.fn(async () => {}))
const setAsAppMenu = vi.hoisted(() => {
  return vi.fn(() => {
    calls.push('setAsAppMenu')
    return Promise.resolve()
  })
})
const menuNew = vi.hoisted(() => {
  return vi.fn((_options: unknown) => {
    return Promise.resolve({ setAsAppMenu, popup, close: () => void closed.push('Menu') })
  })
})
/**
 * Fake methods live on the prototype, so `toEqual` compares only the echoed options and `built`.
 */
const resourceNew = vi.hoisted(() => {
  interface ResourceOptions {
    text?: string
    action?: () => void
  }
  class FakeResource {
    readonly #name: string
    constructor(kind: string, options: ResourceOptions) {
      Object.assign(this, options, { built: kind })
      this.#name = options.text ?? kind
    }
    close(): Promise<void> {
      closed.push(this.#name)
      return Promise.resolve()
    }
  }
  class FakeSubmenu extends FakeResource {
    readonly #text: string | undefined
    constructor(options: ResourceOptions) {
      super('Submenu', options)
      this.#text = options.text
    }
    setAsWindowsMenuForNSApp(): Promise<void> {
      calls.push(`windows:${this.#text}`)
      return Promise.resolve()
    }
    setAsHelpMenuForNSApp(): Promise<void> {
      calls.push(`help:${this.#text}`)
      return Promise.resolve()
    }
  }
  return (kind: string) => {
    return vi.fn((options: ResourceOptions) => {
      return Promise.resolve(
        kind === 'Submenu' ? new FakeSubmenu(options) : new FakeResource(kind, options),
      )
    })
  }
})
const menuItemNew = vi.hoisted(() => resourceNew('MenuItem'))
const checkMenuItemNew = vi.hoisted(() => resourceNew('CheckMenuItem'))
const submenuNew = vi.hoisted(() => resourceNew('Submenu'))

vi.mock('@tauri-apps/api/menu', () => ({
  Menu: { new: menuNew },
  MenuItem: { new: menuItemNew },
  CheckMenuItem: { new: checkMenuItemNew },
  Submenu: { new: submenuNew },
}))

const { createTauriAppMenuHost, createTauriContextMenuService } = await import('./tauri-menu.ts')

beforeEach(() => {
  vi.clearAllMocks()
  calls.length = 0
  closed.length = 0
})

describe('createTauriAppMenuHost', () => {
  const action = vi.fn()
  const layout: NativeSubmenu[] = [
    {
      text: 'View',
      items: [
        {
          kind: 'command',
          id: 'sidebar.toggle',
          text: 'Toggle sidebar',
          accelerator: 'CmdOrCtrl+\\',
          action,
        },
        { kind: 'predefined', item: 'Separator' },
        { kind: 'command', id: 'theme.toggle', text: 'Toggle theme', action },
        { kind: 'predefined', item: 'Quit', text: 'Quit Reflect' },
      ],
    },
    { text: 'Window', nsAppRole: 'windows', items: [{ kind: 'predefined', item: 'Minimize' }] },
    { text: 'Help', nsAppRole: 'help', items: [] },
  ]

  it('builds command items as menu items, so that they keep their click handler', async () => {
    await createTauriAppMenuHost().buildAppMenu(layout)

    const sidebarToggle = {
      id: 'sidebar.toggle',
      text: 'Toggle sidebar',
      accelerator: 'CmdOrCtrl+\\',
      action,
    }
    const themeToggle = { id: 'theme.toggle', text: 'Toggle theme', action }
    expect(menuItemNew.mock.calls).toEqual([[sidebarToggle], [themeToggle]])
    // Submenus build concurrently, so the calls are in no fixed order.
    const view = submenuNew.mock.calls
      .map(([options]) => options)
      .find((options) => options.text === 'View')
    expect(view).toEqual({
      text: 'View',
      items: [
        { ...sidebarToggle, built: 'MenuItem' },
        { item: 'Separator' },
        { ...themeToggle, built: 'MenuItem' },
        { item: 'Quit', text: 'Quit Reflect' },
      ],
    })
    expect(menuNew).toHaveBeenCalledTimes(1)
    expect(setAsAppMenu).not.toHaveBeenCalled()
  })

  it('installs the menu and assigns the NSApp roles only when asked', async () => {
    const menu = await createTauriAppMenuHost().buildAppMenu(layout)
    expect(calls).toEqual([])

    await menu.setAsAppMenu()
    expect(calls).toEqual(['setAsAppMenu'])

    await menu.assignNsAppRoles()
    expect(calls).toEqual(['setAsAppMenu', 'windows:Window', 'help:Help'])
  })
})

describe('createTauriContextMenuService', () => {
  it('builds nested submenus and check items whose actions report the picked id', async () => {
    const onSelect = vi.fn()
    const items: ContextMenuItem[] = [
      { type: 'action', id: 'complete', title: 'Complete' },
      { type: 'separator' },
      {
        type: 'submenu',
        title: 'Schedule',
        items: [
          { type: 'action', id: 'today', title: 'Today', checked: true },
          { type: 'action', id: 'clear', title: 'Clear date', disabled: true },
        ],
      },
    ]

    await createTauriContextMenuService().open({ items, onSelect })

    const action = expect.any(Function) as () => void
    expect(menuNew).toHaveBeenLastCalledWith({
      items: [
        { built: 'MenuItem', text: 'Complete', enabled: true, action },
        { item: 'Separator' },
        {
          built: 'Submenu',
          text: 'Schedule',
          items: [
            { built: 'CheckMenuItem', text: 'Today', enabled: true, checked: true, action },
            { built: 'MenuItem', text: 'Clear date', enabled: false, action },
          ],
        },
      ],
    })
    expect(popup).toHaveBeenCalledTimes(1)

    for (const [options] of [...menuItemNew.mock.calls, ...checkMenuItemNew.mock.calls]) {
      options.action?.()
    }
    expect(onSelect.mock.calls).toEqual([['complete'], ['clear'], ['today']])
  })

  it('closes the previous context menu when the next one opens', async () => {
    const service = createTauriContextMenuService()
    const options = {
      items: [{ type: 'action', id: 'unpin', title: 'Unpin Note' }] satisfies ContextMenuItem[],
      onSelect: vi.fn(),
    }

    await service.open(options)
    expect(closed).toEqual([])

    await service.open(options)
    expect(closed).toEqual(['Unpin Note', 'Menu'])
    expect(popup).toHaveBeenCalledTimes(2)
  })

  it('closes a menu that was still building when the next one opened', async () => {
    const service = createTauriContextMenuService()

    await Promise.all([
      service.open({ items: [{ type: 'action', id: 'first', title: 'First' }], onSelect: vi.fn() }),
      service.open({
        items: [{ type: 'action', id: 'second', title: 'Second' }],
        onSelect: vi.fn(),
      }),
    ])

    expect(closed).toEqual(['First', 'Menu'])
  })
})
