import { returnNull } from '@ocavue/utils'
import type { IpcBridgeService, LoggerService, PlatformFacts, Unlisten } from '@reflect/core'
import {
  createTestIpcBridgeService,
  createTestLoggerService,
  createTestPlatformService,
} from '@reflect/core/testing'
import type { WindowService } from '../app/window-service.ts'
import { createTestWindowService } from './window.ts'
import { type CommandService, createCommandService } from '../commands/command-service.ts'
import {
  createNativeMenuService,
  type AppSubmenuLayout,
  type NativeAppMenu,
  type NativeContextMenuItem,
  type NativeContextMenuOptions,
  type NativeMenuHost,
  type NativeMenuService,
  type NativeSubmenu,
} from '../commands/native-menu-service.ts'

export type TestNativeMenuHostCall = 'buildAppMenu' | 'setAsAppMenu' | 'assignNsAppRoles' | 'popup'

/**
 * A {@link NativeMenuHost} that records what it is asked to build.
 */
export interface TestNativeMenuHost extends NativeMenuHost {
  /**
   * Every host call, in order.
   */
  readonly calls: readonly TestNativeMenuHostCall[]
  /**
   * The submenus of the installed application menu, or `null` when none is installed.
   */
  appMenu(): readonly NativeSubmenu[] | null
  /**
   * The items of every context menu opened, in order.
   */
  popups(): readonly (readonly NativeContextMenuItem[])[]
  /**
   * Picks the enabled action `id` in the latest popup, and throws when there is none.
   */
  select(id: string): void
}

function findAction(
  items: readonly NativeContextMenuItem[],
  id: string,
): Extract<NativeContextMenuItem, { type: 'action' }> | undefined {
  for (const item of items) {
    if (item.type === 'action' && item.id === id) {
      return item
    }
    if (item.type === 'submenu') {
      const found = findAction(item.items, id)
      if (found) {
        return found
      }
    }
  }
  return undefined
}

class TestNativeMenuHostImpl implements TestNativeMenuHost {
  readonly calls: TestNativeMenuHostCall[] = []
  readonly #popups: NativeContextMenuOptions[] = []
  #appMenu: readonly NativeSubmenu[] | null = null

  buildAppMenu(submenus: readonly NativeSubmenu[]): NativeAppMenu {
    this.calls.push('buildAppMenu')
    return {
      setAsAppMenu: () => {
        this.calls.push('setAsAppMenu')
        this.#appMenu = submenus
      },
      assignNsAppRoles: () => {
        this.calls.push('assignNsAppRoles')
      },
    }
  }

  popup(options: NativeContextMenuOptions): void {
    this.calls.push('popup')
    this.#popups.push(options)
  }

  appMenu(): readonly NativeSubmenu[] | null {
    return this.#appMenu
  }

  popups(): readonly (readonly NativeContextMenuItem[])[] {
    return this.#popups.map((options) => options.items)
  }

  select(id: string): void {
    const latest = this.#popups.at(-1)
    const item = latest ? findAction(latest.items, id) : undefined
    if (!latest || !item || (item.disabled ?? false)) {
      throw new Error(`no enabled context menu action: ${id}`)
    }
    latest.onSelect(id)
  }
}

export function createTestNativeMenuHost(): TestNativeMenuHost {
  return new TestNativeMenuHostImpl()
}

export interface TestNativeMenuServiceOptions {
  /**
   * Defaults to a registry with no handlers.
   */
  commands?: CommandService
  /**
   * Defaults to a focused main window.
   */
  window?: WindowService
  /**
   * Defaults to a macOS desktop native shell.
   */
  platform?: PlatformFacts
  /**
   * Defaults to a bridge that answers `menu_install_paste_and_match_style`.
   */
  ipc?: IpcBridgeService
  logger?: LoggerService
}

export interface TestNativeMenuService extends NativeMenuService {
  /**
   * The host the service builds its menus on.
   */
  readonly host: TestNativeMenuHost
}

class TestNativeMenuServiceImpl implements TestNativeMenuService {
  readonly host: TestNativeMenuHost
  readonly dispatchCommand: (commandId: string) => void
  readonly #inner: NativeMenuService

  constructor(host: TestNativeMenuHost, inner: NativeMenuService) {
    this.host = host
    this.#inner = inner
    this.dispatchCommand = inner.dispatchCommand
  }

  install(layout: readonly AppSubmenuLayout[]): Promise<void> {
    return this.#inner.install(layout)
  }

  isInstalled(): boolean {
    return this.#inner.isInstalled()
  }

  connect(): Unlisten {
    return this.#inner.connect()
  }

  openContextMenu(options: NativeContextMenuOptions): Promise<void> {
    return this.#inner.openContextMenu(options)
  }
}

/**
 * The real {@link NativeMenuService} over a {@link TestNativeMenuHost}.
 */
export function createTestNativeMenuService(
  options?: TestNativeMenuServiceOptions,
): TestNativeMenuService {
  const host = createTestNativeMenuHost()
  const logger = options?.logger ?? createTestLoggerService()
  const service = createNativeMenuService({
    commands:
      options?.commands ?? createCommandService({ platform: createTestPlatformService(), logger }),
    window: options?.window ?? createTestWindowService(),
    platform: options?.platform ?? createTestPlatformService(),
    ipc:
      options?.ipc ??
      createTestIpcBridgeService({
        commands: { menu_install_paste_and_match_style: returnNull },
        logger,
      }),
    logger,
    host,
  })
  return new TestNativeMenuServiceImpl(host, service)
}
