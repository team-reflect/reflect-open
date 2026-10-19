import type { MaybePromise } from '@reflect/utils'
import { z } from 'zod'
import type { IpcBridgeService, LoggerService, PlatformFacts, Unlisten } from '@reflect/core'
import { MAIN_WINDOW_LABEL, type WindowService } from '../app/window-service.ts'
import { bindingToAccelerator } from './accelerator.ts'
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
  | { kind: 'command'; commandId: string; text?: string | undefined }
  | { kind: 'predefined'; item: NativeMenuPredefinedItem; text?: string | undefined }

export interface AppSubmenuLayout {
  text: string
  /**
   * macOS NSApp role: `windows` gains the automatic window list,
   * `help` gains the Search field.
   */
  nsAppRole?: 'windows' | 'help'
  entries: AppMenuEntry[]
}

/**
 * One item of a submenu, as a {@link NativeMenuHost} builds it.
 */
export type NativeMenuItem =
  | {
      kind: 'command'
      id: string
      text: string
      accelerator?: string
      /**
       * Invoked with the item id when the item is activated.
       */
      action: (id: string) => void
    }
  | { kind: 'predefined'; item: NativeMenuPredefinedItem; text?: string }

export interface NativeSubmenu {
  text: string
  nsAppRole?: 'windows' | 'help'
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

export interface NativeContextMenuItem {
  /**
   * Visible native menu item label.
   */
  text: string
  /**
   * Invoked when the native menu item is selected.
   */
  action: () => void
}

export interface NativeContextMenuOptions {
  /**
   * Menu items to render in order.
   */
  items: readonly NativeContextMenuItem[]
}

/**
 * The native menu operations behind a {@link NativeMenuService}.
 */
export interface NativeMenuHost {
  buildAppMenu(submenus: readonly NativeSubmenu[]): MaybePromise<NativeAppMenu>
  /**
   * Open a context menu at the pointer.
   */
  popup(items: readonly NativeContextMenuItem[]): MaybePromise<void>
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

export type MenuCommandDispatch = (commandId: string) => void

const FocusedNoteMenuCommandSchema = z.enum(['note.find', 'note.findNext', 'note.findPrevious'])

/**
 * Native menu commands whose target is the focused note webview.
 */
export type FocusedNoteMenuCommand = z.infer<typeof FocusedNoteMenuCommandSchema>

const FOCUSED_NOTE_MENU_EVENT = 'reflect://focused-note-menu-command'

/**
 * The native macOS application menu and native context menus. Command items
 * derive from the command registry — id, label, and accelerator come from the
 * one command definition — so the menu cannot drift from the bindings that
 * fire.
 *
 * The menu is built once at startup, before the UI mounts, so item
 * activations go to {@link NativeMenuService.dispatchCommand} and from there
 * to the dispatcher that the mounted workspace published. While no dispatcher
 * is set, menu items are inert.
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
   * Publish (or with `null`, withdraw) the active menu-command dispatcher.
   */
  setCommandDispatch(dispatch: MenuCommandDispatch | null): void
  /**
   * Forward a native menu activation to the focused webview. Find commands are
   * note-window-local; all other commands go to the published dispatcher. A
   * function property: menu items hold it as their detached action.
   */
  dispatchCommand: (commandId: string) => void
  /**
   * Listen for native Find menu commands routed to this focused note window.
   */
  subscribeFocusedNoteCommands(listener: (commandId: FocusedNoteMenuCommand) => void): Unlisten
  /**
   * Open a native context menu. Outside a native shell, this is a no-op so
   * browser and test shells can call the same path without platform guards.
   */
  openContextMenu(options: NativeContextMenuOptions): Promise<void>
}

export interface NativeMenuServiceDeps {
  readonly commands: CommandService
  readonly window: WindowService
  readonly platform: PlatformFacts
  readonly ipc: IpcBridgeService
  readonly logger: LoggerService
  readonly host: NativeMenuHost
}

class NativeMenuServiceImpl implements NativeMenuService {
  readonly #deps: NativeMenuServiceDeps
  #installed = false
  #current: MenuCommandDispatch | null = null
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
        ...(submenu.nsAppRole !== undefined ? { nsAppRole: submenu.nsAppRole } : {}),
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
    // see `src-tauri/src/menu.rs` for the full explanation with source links.
    // Best-effort: the menu works without the item, so a failed call must
    // not make the whole install look failed.
    try {
      await ipc.call('menu_install_paste_and_match_style', {}, z.null())
    } catch (error) {
      logger.warn('failed to add the Paste and Match Style menu item:', error)
    }
  }

  isInstalled(): boolean {
    return this.#installed
  }

  setCommandDispatch(dispatch: MenuCommandDispatch | null): void {
    this.#current = dispatch
  }

  readonly dispatchCommand = (commandId: string): void => {
    const focusedNoteCommand = FocusedNoteMenuCommandSchema.safeParse(commandId)
    if (this.#deps.platform.isNativeShell && focusedNoteCommand.success) {
      void this.#dispatchToFocusedWindow(focusedNoteCommand.data)
      return
    }
    this.#current?.(commandId)
  }

  subscribeFocusedNoteCommands(listener: (commandId: FocusedNoteMenuCommand) => void): Unlisten {
    return this.#deps.window.subscribeWindowEvent(FOCUSED_NOTE_MENU_EVENT, (payload) => {
      const command = FocusedNoteMenuCommandSchema.safeParse(payload)
      if (command.success) {
        listener(command.data)
      }
    })
  }

  async openContextMenu(options: NativeContextMenuOptions): Promise<void> {
    if (!this.#deps.platform.isNativeShell) {
      return
    }
    await this.#deps.host.popup(options.items)
  }

  async #dispatchToFocusedWindow(commandId: FocusedNoteMenuCommand): Promise<void> {
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

    if (focusedLabel !== MAIN_WINDOW_LABEL) {
      try {
        await window.emitTo(focusedLabel, FOCUSED_NOTE_MENU_EVENT, commandId)
      } catch (cause) {
        // Never fall through to the main note: the command belongs to the
        // focused detached window, even if its event channel just disappeared.
        logger.error('focused note menu dispatch failed:', cause)
      }
      return
    }
    this.#current?.(commandId)
  }

  #menuItem(entry: AppMenuEntry): NativeMenuItem {
    if (entry.kind === 'predefined') {
      return {
        kind: 'predefined',
        item: entry.item,
        ...(entry.text !== undefined ? { text: entry.text } : {}),
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
      ...(accelerator !== undefined ? { accelerator } : {}),
      action: this.dispatchCommand,
    }
  }
}

export function createNativeMenuService(deps: NativeMenuServiceDeps): NativeMenuService {
  return new NativeMenuServiceImpl(deps)
}
