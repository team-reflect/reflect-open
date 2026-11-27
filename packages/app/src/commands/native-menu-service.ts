import type { MaybePromise } from '@reflect/utils'
import type { IpcBridgeService, LoggerService, PlatformFacts, Unlisten } from '@reflect/core'
import { MAIN_WINDOW_LABEL, type WindowService } from '../app/window-service.ts'
import { bindingToAccelerator } from './accelerator.ts'
import type { AppCommandId } from './app-commands.ts'
import type { CommandService } from './command-service.ts'

/**
 * A menu item whose behavior the operating system implements.
 */
export type NativeMenuPredefinedItem =
  | 'Separator'
  | 'Copy'
  | 'Cut'
  | 'Paste'
  | 'SelectAll'
  | 'Undo'
  | 'Redo'
  | 'Minimize'
  | 'Maximize'
  | 'Fullscreen'
  | 'Hide'
  | 'HideOthers'
  | 'ShowAll'
  | 'CloseWindow'
  | 'Quit'
  | 'Services'
  | 'BringAllToFront'
  | { About: null }

export type AppMenuEntry =
  | { kind: 'command'; commandId: AppCommandId; text?: string | undefined }
  | { kind: 'predefined'; item: NativeMenuPredefinedItem; text?: string | undefined }

export interface AppSubmenuLayout {
  text: string
  /**
   * macOS NSApp role: `windows` gains the automatic window list,
   * `help` gains the Search field.
   */
  nsAppRole?: 'windows' | 'help' | undefined
  entries: AppMenuEntry[]
}

/**
 * One item of a submenu, as a {@link NativeMenuHost} builds it.
 */
export type NativeMenuItem =
  | {
      kind: 'command'
      id?: string | undefined
      text: string
      accelerator?: string | undefined
      enabled?: boolean | undefined
      /**
       * Any boolean makes a check item, so `false` shows an unchecked check item.
       */
      checked?: boolean | undefined
      /**
       * Invoked on activation with `id`, or with a host-generated id when `id` is unset.
       */
      action: (id: string) => void
    }
  | { kind: 'predefined'; item: NativeMenuPredefinedItem; text?: string | undefined }
  | { kind: 'submenu'; text: string; items: readonly NativeMenuItem[] }

export interface NativeSubmenu {
  text: string
  nsAppRole?: 'windows' | 'help' | undefined
  items: NativeMenuItem[]
}

/**
 * An application menu that a {@link NativeMenuHost} built but has not installed yet.
 */
export interface NativeAppMenu {
  /**
   * Install the menu as the application menu, replacing the current one.
   */
  setAsAppMenu(): MaybePromise<void>
  /**
   * Give each submenu its `nsAppRole`. Call it after {@link setAsAppMenu}.
   */
  assignNsAppRoles(): MaybePromise<void>
}

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
 * The native menu operations behind a {@link NativeMenuService}.
 */
export interface NativeMenuHost {
  buildAppMenu(submenus: readonly NativeSubmenu[]): MaybePromise<NativeAppMenu>
  /**
   * Open a context menu at the pointer.
   */
  popup(items: readonly NativeMenuItem[]): MaybePromise<void>
}

/**
 * A host without native menus: every operation rejects.
 */
export function createUnsupportedNativeMenuHost(): NativeMenuHost {
  const unsupported = async (): Promise<never> => {
    return await Promise.reject(new Error('native menus are not supported on this host'))
  }
  return { buildAppMenu: unsupported, popup: unsupported }
}

/**
 * The window event that carries a menu command to the webview that runs it.
 */
const MENU_COMMAND_EVENT = 'reflect://menu-command'

/**
 * The native macOS application menu and native context menus. Command items
 * derive from the command registry — id, label, and accelerator come from the
 * one command definition — so the menu cannot drift from the bindings that
 * fire.
 *
 * The menu is built once at startup, before the UI mounts. An item
 * activation runs its command in the focused webview; a note window hands a
 * command it has no handler for to the main window. A command with no
 * handler anywhere does nothing.
 */
export interface NativeMenuService {
  /**
   * Build the application menu from `layout` and install it, replacing the
   * host's default. Call once at startup — the menu holds command ids, not
   * state, so it never needs rebuilding.
   *
   * macOS-only, and only in the main window: menu actions use channels owned
   * by the webview that created them, so a note window must not replace the
   * app-wide menu with an inert copy.
   */
  install(layout: readonly AppSubmenuLayout[]): Promise<void>
  /**
   * Whether this webview has successfully installed the native app menu.
   */
  isInstalled(): boolean
  /**
   * Run a native menu activation in the focused webview. A function property:
   * menu items hold it as their detached action.
   */
  dispatchCommand: (commandId: string) => void
  /**
   * Run the menu commands that other webviews send to this one. Call once per
   * webview at startup.
   */
  connect(): Unlisten
  /**
   * Open a native context menu. Outside a native shell, this is a no-op so
   * browser and test shells can call the same path without platform guards.
   */
  openContextMenu(options: ContextMenuOptions): Promise<void>
}

export interface NativeMenuServiceDeps {
  readonly commands: CommandService
  readonly window: WindowService
  readonly platform: PlatformFacts
  readonly ipc: IpcBridgeService
  readonly logger: LoggerService
  readonly host: NativeMenuHost
}

function resolveContextMenuItem(
  item: ContextMenuItem,
  onSelect: (id: string) => void,
): NativeMenuItem {
  if (item.type === 'separator') {
    return { kind: 'predefined', item: 'Separator' }
  }
  if (item.type === 'submenu') {
    return {
      kind: 'submenu',
      text: item.title,
      items: item.items.map((child) => resolveContextMenuItem(child, onSelect)),
    }
  }
  // No id: Tauri keys click channels by id, so a shared id would replace an app menu item's channel.
  return {
    kind: 'command',
    text: item.title,
    enabled: !(item.disabled ?? false),
    checked: item.checked,
    action: () => onSelect(item.id),
  }
}

class NativeMenuServiceImpl implements NativeMenuService {
  readonly #deps: NativeMenuServiceDeps
  #installed = false
  readonly #mainWindow: boolean

  constructor(deps: NativeMenuServiceDeps) {
    this.#deps = deps
    this.#mainWindow = deps.window.isMainWindow()
  }

  async install(layout: readonly AppSubmenuLayout[]): Promise<void> {
    const { platform, ipc, logger, host } = this.#deps
    if (!platform.isMacosDesktop || !this.#mainWindow) {
      return
    }
    const menu = await host.buildAppMenu(
      layout.map((submenu) => ({
        text: submenu.text,
        nsAppRole: submenu.nsAppRole,
        items: submenu.entries.map((entry) => this.#menuItem(entry)),
      })),
    )
    await menu.setAsAppMenu()
    this.#installed = true
    // NSApp roles must be assigned after setAsAppMenu: attaching the menu
    // clones each submenu's NSMenu, and muda resolves the role against the
    // instance inside the installed main menu — assigned earlier, the role
    // silently no-ops and macOS never adds its automatic items (the window
    // list and Move & Resize/tiling with their system shortcuts; Help search).
    await menu.assignNsAppRoles()
    // Must run after setAsAppMenu, like the role assignment above: it adds the
    // Edit > "Paste and Match Style" (⌘⇧V) item to the menu that was just
    // installed. The menu API cannot create that item (it needs a native macOS
    // action selector), so a Rust command does it with direct AppKit calls;
    // see `apps/tauri/src/menu.rs` for the full explanation with source links.
    // Best-effort: the menu works without the item, so a failed call must
    // not make the whole install look failed.
    try {
      await ipc.call('menu_install_paste_and_match_style', {})
    } catch (error) {
      logger.warn('failed to add the Paste and Match Style menu item:', error)
    }
  }

  isInstalled(): boolean {
    return this.#installed
  }

  readonly dispatchCommand = (commandId: string): void => {
    const id = this.#declaredId(commandId)
    if (id === null) {
      return
    }
    if (!this.#deps.platform.isNativeShell) {
      this.#deps.commands.trigger(id)
      return
    }
    void this.#dispatchToFocusedWindow(id)
  }

  connect(): Unlisten {
    return this.#deps.window.subscribeWindowEvent(MENU_COMMAND_EVENT, (payload) => {
      const id = typeof payload === 'string' ? this.#declaredId(payload) : null
      if (id === null) {
        return
      }
      if (this.#mainWindow || this.#deps.commands.isHandled(id)) {
        // A block in this window may stop the command; it never moves to main.
        this.#deps.commands.trigger(id)
        return
      }
      // App-wide commands (New note, Settings, ...) have their handlers in the
      // main window only.
      void this.#handOffToMainWindow(id)
    })
  }

  async openContextMenu(options: ContextMenuOptions): Promise<void> {
    if (!this.#deps.platform.isNativeShell) {
      return
    }
    await this.#deps.host.popup(
      options.items.map((item) => resolveContextMenuItem(item, options.onSelect)),
    )
  }

  async #dispatchToFocusedWindow(commandId: AppCommandId): Promise<void> {
    const { window, logger } = this.#deps
    let focusedLabel: string | null = null
    try {
      focusedLabel = await window.focusedWindowLabel()
    } catch (cause) {
      logger.error('focused window lookup failed:', cause)
      return
    }

    if (focusedLabel === null) {
      // A menu activation can briefly leave macOS without a focused webview.
      // Never guess `main`: acting on the wrong note is worse than leaving this
      // one activation inert.
      return
    }

    if (focusedLabel === MAIN_WINDOW_LABEL) {
      this.#deps.commands.trigger(commandId)
      return
    }
    try {
      await window.emitTo(focusedLabel, MENU_COMMAND_EVENT, commandId)
    } catch (cause) {
      // Never fall through to the main window: the command belongs to the
      // focused window, even if its event channel just disappeared.
      logger.error('focused window menu dispatch failed:', cause)
    }
  }

  async #handOffToMainWindow(commandId: AppCommandId): Promise<void> {
    try {
      await this.#deps.window.emitTo(MAIN_WINDOW_LABEL, MENU_COMMAND_EVENT, commandId)
    } catch (cause) {
      this.#deps.logger.error('menu command handoff to the main window failed:', cause)
    }
  }

  /**
   * The declared command id that `commandId` names, or `null`. The host
   * returns menu item ids as plain strings.
   */
  #declaredId(commandId: string): AppCommandId | null {
    return this.#deps.commands.list().find((command) => command.id === commandId)?.id ?? null
  }

  #menuItem(entry: AppMenuEntry): NativeMenuItem {
    if (entry.kind === 'predefined') {
      return {
        kind: 'predefined',
        item: entry.item,
        text: entry.text,
      }
    }
    const command = this.#deps.commands.list().find((candidate) => candidate.id === entry.commandId)
    if (!command) {
      throw new Error(`native menu references unknown command: ${entry.commandId}`)
    }
    const accelerator = command.keybinding ? bindingToAccelerator(command.keybinding) : undefined
    return {
      kind: 'command',
      id: command.id,
      text: entry.text ?? command.title,
      accelerator,
      action: this.dispatchCommand,
    }
  }
}

export function createNativeMenuService(deps: NativeMenuServiceDeps): NativeMenuService {
  return new NativeMenuServiceImpl(deps)
}
