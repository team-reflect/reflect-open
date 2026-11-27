import {
  bindingToAccelerator,
  type NativeContextMenuItem,
  type NativeMenuHost,
  type NativeMenuItem,
  type NativeSubmenu,
} from '@reflect/app'
import type { Resource } from '@tauri-apps/api/core'
import {
  CheckMenuItem,
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
  type PredefinedMenuItemOptions,
} from '@tauri-apps/api/menu'

// Inline item options lose their click handler once the submenu is built.
async function menuEntry(item: NativeMenuItem): Promise<MenuItem | PredefinedMenuItemOptions> {
  return item.kind === 'command'
    ? await MenuItem.new({
        id: item.id,
        text: item.text,
        ...(item.accelerator !== undefined ? { accelerator: item.accelerator } : {}),
        action: item.action,
      })
    : { item: item.item, ...(item.text !== undefined ? { text: item.text } : {}) }
}

type ContextMenuEntry = MenuItem | CheckMenuItem | PredefinedMenuItem | Submenu

async function buildContextMenuEntries(
  items: readonly NativeContextMenuItem[],
  onSelect: (id: string) => void,
  built: Resource[],
): Promise<ContextMenuEntry[]> {
  return await Promise.all(
    items.map(async (item) => {
      const entry = await buildContextMenuEntry(item, onSelect, built)
      built.push(entry)
      return entry
    }),
  )
}

async function buildContextMenuEntry(
  item: NativeContextMenuItem,
  onSelect: (id: string) => void,
  built: Resource[],
): Promise<ContextMenuEntry> {
  if (item.type === 'separator') {
    return await PredefinedMenuItem.new({ item: 'Separator' })
  }
  if (item.type === 'submenu') {
    return await Submenu.new({
      text: item.title,
      items: await buildContextMenuEntries(item.items, onSelect, built),
    })
  }
  // No Tauri id: Tauri keys click channels by id, so a shared id would replace an app menu item's channel.
  const options = {
    text: item.title,
    enabled: !(item.disabled ?? false),
    ...(item.shortcut !== undefined ? { accelerator: bindingToAccelerator(item.shortcut) } : {}),
    action: () => onSelect(item.id),
  }
  return item.checked === undefined
    ? await MenuItem.new(options)
    : await CheckMenuItem.new({ ...options, checked: item.checked })
}

type NativeAppMenu = Awaited<ReturnType<NativeMenuHost['buildAppMenu']>>

class TauriNativeAppMenu implements NativeAppMenu {
  readonly #menu: Menu
  readonly #layouts: readonly NativeSubmenu[]
  readonly #submenus: readonly Submenu[]

  constructor(menu: Menu, layouts: readonly NativeSubmenu[], submenus: readonly Submenu[]) {
    this.#menu = menu
    this.#layouts = layouts
    this.#submenus = submenus
  }

  async setAsAppMenu(): Promise<void> {
    await this.#menu.setAsAppMenu()
  }

  async assignNsAppRoles(): Promise<void> {
    for (const [index, layout] of this.#layouts.entries()) {
      const submenu = this.#submenus[index]
      if (!submenu) {
        continue
      }
      if (layout.nsAppRole === 'windows') {
        await submenu.setAsWindowsMenuForNSApp()
      } else if (layout.nsAppRole === 'help') {
        await submenu.setAsHelpMenuForNSApp()
      }
    }
  }
}

/**
 * Native menus through Tauri's menu API. Use this adapter only in the native shell.
 */
export function createTauriNativeMenuHost(): NativeMenuHost {
  // The pick arrives after `popup()` resolves, so the previous menu is closed when the next one opens.
  let contextMenuResources: Resource[] = []

  return {
    async buildAppMenu(layouts) {
      const submenus = await Promise.all(
        layouts.map(async (layout) => {
          return await Submenu.new({
            text: layout.text,
            items: await Promise.all(layout.items.map(menuEntry)),
          })
        }),
      )
      const menu = await Menu.new({ items: submenus })
      return new TauriNativeAppMenu(menu, layouts, submenus)
    },
    async popup({ items, onSelect }) {
      const stale = contextMenuResources
      const built: Resource[] = []
      contextMenuResources = built
      await Promise.allSettled(stale.map((resource) => resource.close()))
      const menu = await Menu.new({ items: await buildContextMenuEntries(items, onSelect, built) })
      built.push(menu)
      await menu.popup()
    },
  }
}
