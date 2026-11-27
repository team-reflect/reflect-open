import type { MaybePromise } from '@reflect/utils'

export interface ContextMenuAction {
  type: 'action'
  id: string
  title: string
  disabled?: boolean | undefined
  /**
   * Any boolean makes a check item, so `false` shows an unchecked check item.
   */
  checked?: boolean | undefined
  /**
   * Hosts that support it show the action as destructive; others ignore it.
   */
  destructive?: boolean | undefined
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
  items: MaybePromise<readonly ContextMenuItem[]>
  onSelect: (id: string) => void
}

export interface ContextMenuService {
  /**
   * Opens a menu for the `contextmenu` event being handled. Call it
   * synchronously in the event handler: a host binds the menu to the event
   * that asked for it.
   */
  open(options: ContextMenuOptions): Promise<void>
}

export function createUnsupportedContextMenuService(): ContextMenuService {
  return {
    open: async () => {
      return await Promise.reject(new Error('context menus are not supported on this host'))
    },
  }
}
