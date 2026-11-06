import {
  bindingToKeyEquivalent,
  type NativeAppMenu,
  type NativeMenuHost,
  type NativeSubmenu,
} from '@reflect/app'
import {
  mainMenuCommandEvent,
  presentContextMenuCommand,
  setMainMenuCommand,
  type IpcBridgeService,
  type LoggerService,
  type MainMenuItem,
  type MainMenuPlacement,
  type MainMenuSection,
  type Unlisten,
} from '@reflect/core'

const STANDARD_MENUS: Readonly<Record<string, MainMenuPlacement>> = {
  file: 'file',
  edit: 'edit',
  view: 'view',
  window: 'window',
  help: 'help',
}

/**
 * The first submenu is the app menu, as on macOS; the rest join the system
 * menu of the same title, or become menus of their own.
 */
function placementOf(submenu: NativeSubmenu, index: number): MainMenuPlacement | null {
  if (index === 0) {
    return 'application'
  }
  return STANDARD_MENUS[submenu.text.toLowerCase()] ?? null
}

/**
 * Command items keep their id, title and key equivalent. Of the predefined
 * items only separators survive: iPadOS supplies its own Undo, Copy, Close
 * Window and friends in the standard menus, with the system's shortcuts.
 */
function sectionItems(submenu: NativeSubmenu): MainMenuItem[] {
  return submenu.items.flatMap((item): MainMenuItem[] => {
    if (item.kind === 'predefined') {
      return item.item === 'Separator' ? [{ kind: 'separator' }] : []
    }
    const keyEquivalent = item.binding === undefined ? null : bindingToKeyEquivalent(item.binding)
    return [
      {
        kind: 'command',
        id: item.id,
        title: item.text,
        ...(keyEquivalent !== null ? { keyEquivalent } : {}),
      },
    ]
  })
}

interface IpadMainMenuDeps {
  readonly ipc: IpcBridgeService
  readonly logger: LoggerService
}

class IpadMainMenu implements NativeAppMenu {
  readonly #deps: IpadMainMenuDeps
  readonly #sections: readonly MainMenuSection[]
  readonly #actions: ReadonlyMap<string, (id: string) => void>
  #unlisten: Unlisten | null = null

  constructor(deps: IpadMainMenuDeps, submenus: readonly NativeSubmenu[]) {
    this.#deps = deps
    this.#sections = submenus.map((submenu, index) => ({
      title: submenu.text,
      placement: placementOf(submenu, index),
      items: sectionItems(submenu),
    }))
    const actions = new Map<string, (id: string) => void>()
    for (const submenu of submenus) {
      for (const item of submenu.items) {
        if (item.kind === 'command') {
          actions.set(item.id, item.action)
        }
      }
    }
    this.#actions = actions
  }

  async setAsAppMenu(): Promise<void> {
    if (this.#unlisten === null) {
      const subscription = mainMenuCommandEvent(this.#deps.ipc, ({ id }) => {
        const action = this.#actions.get(id)
        if (action === undefined) {
          this.#deps.logger.warn('the menu bar reported an unknown command:', id)
          return
        }
        action(id)
      })
      this.#unlisten = subscription.unlisten
      await subscription.ready
    }
    await this.#install(this.#sections)
  }

  assignNsAppRoles(): void {}

  async setCommandsAvailable(available: boolean): Promise<void> {
    await this.#install(available ? this.#sections : [])
  }

  async #install(sections: readonly MainMenuSection[]): Promise<void> {
    await setMainMenuCommand(this.#deps.ipc, { request: { sections } })
  }
}

/**
 * The iPad's native menus through `tauri-plugin-native-menu`, standing in for
 * the Tauri menu plugin, which does not exist on iOS.
 *
 * The menu bar (iPadOS 26+; earlier iPadOS has no menu bar and the plugin
 * installs nothing) takes the same layout as the macOS app menu, so the two
 * cannot drift. While no workspace can run commands (the phone shell in a
 * compact window), it keeps only the system's items.
 *
 * Context menus present at the point the caller passes, since a touch leaves
 * no pointer behind; a trackpad's secondary click gets iPadOS's context-menu
 * presentation.
 */
export function createIpadNativeMenuHost(deps: IpadMainMenuDeps): NativeMenuHost {
  return {
    buildAppMenu: (submenus) => new IpadMainMenu(deps, submenus),
    popup: async (items, at) => {
      if (at === undefined) {
        throw new Error('an iPad context menu needs the point it belongs at')
      }
      const { id } = await presentContextMenuCommand(deps.ipc, {
        request: {
          items: items.map((item, index) => ({ id: String(index), title: item.text })),
          x: at.x,
          y: at.y,
        },
      })
      if (id !== null) {
        items[Number(id)]?.action()
      }
    },
  }
}
