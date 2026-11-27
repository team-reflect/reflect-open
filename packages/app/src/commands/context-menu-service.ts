export interface ContextMenuAction {
  type: 'action'
  id: string
  title: string
  disabled?: boolean | undefined
  /**
   * Any boolean makes a check item, so `false` shows an unchecked check item.
   */
  checked?: boolean | undefined
}

export interface ContextMenuSeparator {
  type: 'separator'
}

export interface ContextMenuSubmenu {
  type: 'submenu'
  title: string
  items: readonly ContextMenuItem[]
}

export type ContextMenuItem = ContextMenuAction | ContextMenuSeparator | ContextMenuSubmenu

export interface ContextMenuOptions {
  items: readonly ContextMenuItem[]
  onSelect: (id: string) => void
}

export interface ContextMenuService {
  open(options: ContextMenuOptions): Promise<void>
}

/**
 * A `ContextMenuService` whose `open` rejects.
 */
export function createUnsupportedContextMenuService(): ContextMenuService {
  return {
    open: async () => {
      return await Promise.reject(new Error('context menus are not supported on this host'))
    },
  }
}
