import type {
  AppMenuHost,
  ContextMenuItem,
  ContextMenuOptions,
  ContextMenuService,
  NativeAppMenu,
  NativeMenuItem,
  NativeSubmenu,
} from '@reflect/app'
import type { Resource } from '@tauri-apps/api/core'
import {
  CheckMenuItem,
  Menu,
  MenuItem,
  Submenu,
  type PredefinedMenuItemOptions,
} from '@tauri-apps/api/menu'

type MenuEntry = MenuItem | CheckMenuItem | Submenu | PredefinedMenuItemOptions

// Inline item options lose their click handler once the submenu is built.
async function buildAppMenuEntry(item: NativeMenuItem): Promise<MenuEntry> {
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

async function buildContextMenuEntries(
  items: readonly ContextMenuItem[],
  onSelect: (id: string) => void,
  onBuilt: (resource: Resource) => void,
): Promise<MenuEntry[]> {
  return await Promise.all(items.map((item) => buildContextMenuEntry(item, onSelect, onBuilt)))
}

async function buildContextMenuEntry(
  item: ContextMenuItem,
  onSelect: (id: string) => void,
  onBuilt: (resource: Resource) => void,
): Promise<MenuEntry> {
  if (item.type === 'separator') {
    return { item: 'Separator' }
  }
  let entry: MenuItem | CheckMenuItem | Submenu
  if (item.type === 'submenu') {
    entry = await Submenu.new({
      text: item.title,
      items: await buildContextMenuEntries(item.items, onSelect, onBuilt),
    })
  } else {
    // No id: Tauri keys click channels by id, so a shared id would replace an app menu item's channel.
    const options = {
      text: item.title,
      enabled: !(item.disabled ?? false),
      action: () => onSelect(item.id),
    }
    entry =
      item.checked === undefined
        ? await MenuItem.new(options)
        : await CheckMenuItem.new({ ...options, checked: item.checked })
  }
  onBuilt(entry)
  return entry
}

/**
 * Context menus through Tauri's menu API. Use this adapter only in the native shell.
 */
export function createTauriContextMenuService(): ContextMenuService {
  // The pick arrives after `popup()` resolves, so the previous menu is closed when the next one opens.
  let resources: Resource[] = []
  let latestPopup: Promise<void> = Promise.resolve()

  async function popupNow({ items, onSelect }: ContextMenuOptions): Promise<void> {
    await Promise.allSettled(resources.map((resource) => resource.close()))
    const built: Resource[] = []
    resources = built
    const menu = await Menu.new({
      items: await buildContextMenuEntries(
        items,
        onSelect,
        (resource) => void built.push(resource),
      ),
    })
    built.push(menu)
    await menu.popup()
  }

  return {
    async open(options) {
      const open = (): Promise<void> => popupNow(options)
      latestPopup = latestPopup.then(open, open)
      await latestPopup
    },
  }
}
