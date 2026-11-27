import { noop } from '@ocavue/utils'
import type { NativeMenuHost, NativeMenuItem, NativeSubmenu } from '@reflect/app'
import type { Resource } from '@tauri-apps/api/core'
import {
  CheckMenuItem,
  Menu,
  MenuItem,
  Submenu,
  type PredefinedMenuItemOptions,
} from '@tauri-apps/api/menu'

type MenuEntry = MenuItem | CheckMenuItem | Submenu | PredefinedMenuItemOptions

async function buildMenuEntries(
  items: readonly NativeMenuItem[],
  onBuilt: (resource: Resource) => void,
): Promise<MenuEntry[]> {
  return await Promise.all(items.map((item) => buildMenuEntry(item, onBuilt)))
}

async function buildMenuEntry(
  item: NativeMenuItem,
  onBuilt: (resource: Resource) => void,
): Promise<MenuEntry> {
  if (item.kind === 'predefined') {
    return { item: item.item, ...(item.text !== undefined ? { text: item.text } : {}) }
  }
  const entry =
    item.kind === 'submenu'
      ? await Submenu.new({ text: item.text, items: await buildMenuEntries(item.items, onBuilt) })
      : await buildCommandEntry(item)
  onBuilt(entry)
  return entry
}

// Inline item options lose their click handler once the submenu is built.
async function buildCommandEntry(
  item: Extract<NativeMenuItem, { kind: 'command' }>,
): Promise<MenuItem | CheckMenuItem> {
  const options = {
    ...(item.id !== undefined ? { id: item.id } : {}),
    text: item.text,
    ...(item.accelerator !== undefined ? { accelerator: item.accelerator } : {}),
    ...(item.enabled !== undefined ? { enabled: item.enabled } : {}),
    action: item.action,
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
  let latestPopup: Promise<void> = Promise.resolve()

  async function popupNow(items: readonly NativeMenuItem[]): Promise<void> {
    await Promise.allSettled(contextMenuResources.map((resource) => resource.close()))
    const built: Resource[] = []
    contextMenuResources = built
    const menu = await Menu.new({
      items: await buildMenuEntries(items, (resource) => void built.push(resource)),
    })
    built.push(menu)
    await menu.popup()
  }

  return {
    async buildAppMenu(layouts) {
      const submenus = await Promise.all(
        layouts.map(async (layout) => {
          return await Submenu.new({
            text: layout.text,
            items: await buildMenuEntries(layout.items, noop),
          })
        }),
      )
      const menu = await Menu.new({ items: submenus })
      return new TauriNativeAppMenu(menu, layouts, submenus)
    },
    async popup(items) {
      const open = (): Promise<void> => popupNow(items)
      latestPopup = latestPopup.then(open, open)
      await latestPopup
    },
  }
}
