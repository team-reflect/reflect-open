export interface ContextMenuAction {
  type: 'action'
  id: string
  title: string
  disabled?: boolean | undefined
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
  /**
   * Menu items to render in order.
   */
  items: readonly ContextMenuItem[]
  onSelect: (id: string) => void
}

/**
 * Context menus at the pointer.
 */
export interface ContextMenuService {
  open(options: ContextMenuOptions): Promise<void>
}

/**
 * A host without context menus: opening one rejects.
 */
export function createUnsupportedContextMenuService(): ContextMenuService {
  return {
    open: async () => {
      return await Promise.reject(new Error('context menus are not supported on this host'))
    },
  }
}
