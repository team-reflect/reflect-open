import type { AppMenuHost, NativeAppMenu, NativeMenuItem, NativeSubmenu } from '@reflect/app'
import { Menu, MenuItem, Submenu, type PredefinedMenuItemOptions } from '@tauri-apps/api/menu'

// Inline item options lose their click handler once the submenu is built.
async function buildAppMenuEntry(
  item: NativeMenuItem,
): Promise<MenuItem | PredefinedMenuItemOptions> {
  if (item.kind === 'predefined') {
    return { item: item.item, ...(item.text !== undefined ? { text: item.text } : {}) }
  }
  return await MenuItem.new({
    id: item.id,
    text: item.text,
    ...(item.accelerator !== undefined ? { accelerator: item.accelerator } : {}),
    action: item.action,
  })
}

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
 * The application menu through Tauri's menu API. Use this adapter only in the native shell.
 */
export function createTauriAppMenuHost(): AppMenuHost {
  return {
    async buildAppMenu(layouts) {
      const submenus = await Promise.all(
        layouts.map(async (layout) => {
          return await Submenu.new({
            text: layout.text,
            items: await Promise.all(layout.items.map(buildAppMenuEntry)),
          })
        }),
      )
      const menu = await Menu.new({ items: submenus })
      return new TauriNativeAppMenu(menu, layouts, submenus)
    },
  }
}
