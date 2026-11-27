import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContextMenuItem } from '@reflect/app'
import {
  checkMenuItemNew,
  closedMenus,
  menuItemNew,
  menuNew,
  popup,
  resetFakeTauriMenu,
} from '@/test-utils/tauri-menu.ts'

vi.mock('@tauri-apps/api/menu', () => import('@/test-utils/tauri-menu.ts'))

const { createTauriContextMenuService } = await import('./tauri-context-menu-service.ts')

beforeEach(resetFakeTauriMenu)

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
          { type: 'action', id: 'clear', title: 'Clear date', disabled: true, checked: false },
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
            { built: 'CheckMenuItem', text: 'Clear date', enabled: false, checked: false, action },
          ],
        },
      ],
    })
    expect(popup).toHaveBeenCalledTimes(1)

    for (const [options] of [...menuItemNew.mock.calls, ...checkMenuItemNew.mock.calls]) {
      options.action?.()
    }
    expect(onSelect.mock.calls).toEqual([['complete'], ['today'], ['clear']])
  })

  it('closes the previous context menu when the next one opens', async () => {
    const service = createTauriContextMenuService()
    const options = {
      items: [{ type: 'action', id: 'unpin', title: 'Unpin Note' }] satisfies ContextMenuItem[],
      onSelect: vi.fn(),
    }

    await service.open(options)
    expect(closedMenus).toEqual([])

    await service.open(options)
    expect(closedMenus).toEqual(['Unpin Note', 'Menu'])
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

    expect(closedMenus).toEqual(['First', 'Menu'])
  })
})
