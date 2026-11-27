import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeSubmenu } from '@reflect/app'
import {
  menuCalls as calls,
  menuItemNew,
  menuNew,
  resetFakeTauriMenu,
  setAsAppMenu,
  submenuNew,
} from '@/test-utils/tauri-menu.ts'

vi.mock('@tauri-apps/api/menu', () => import('@/test-utils/tauri-menu.ts'))

const { createTauriAppMenuHost } = await import('./tauri-app-menu-host.ts')

beforeEach(resetFakeTauriMenu)

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
