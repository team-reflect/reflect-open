import { isTauri } from '@tauri-apps/api/core'
import { Menu, type MenuItemOptions } from '@tauri-apps/api/menu'

export interface NativeContextMenuItem {
  /** Visible native menu item label. */
  text: string
  /** Invoked when the native menu item is selected. */
  action: () => void
}

export interface NativeContextMenuOptions {
  /** Menu items to render in order. */
  items: readonly NativeContextMenuItem[]
}

/**
 * Open a Tauri native context menu. Outside Tauri, this is a no-op so browser
 * and test shells can call the same path without platform guards.
 */
export async function openNativeContextMenu(options: NativeContextMenuOptions): Promise<void> {
  if (!isTauri()) {
    return
  }

  const menuItems: MenuItemOptions[] = options.items.map((item) => ({
    text: item.text,
    action: item.action,
  }))
  const menu = await Menu.new({ items: menuItems })
  await menu.popup()
}
