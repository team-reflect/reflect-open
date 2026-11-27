import type { AppMenuHost, NativeAppMenu, NativeSubmenu } from '../commands/app-menu-service.ts'

export type TestAppMenuHostCall = 'buildAppMenu' | 'setAsAppMenu' | 'assignNsAppRoles'

/**
 * An {@link AppMenuHost} that records what it is asked to build.
 */
export interface TestAppMenuHost extends AppMenuHost {
  /**
   * Every host call, in order.
   */
  readonly calls: readonly TestAppMenuHostCall[]
  /**
   * The submenus of the installed application menu, or `null` when none is installed.
   */
  appMenu(): readonly NativeSubmenu[] | null
}

class TestAppMenuHostImpl implements TestAppMenuHost {
  readonly calls: TestAppMenuHostCall[] = []
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

  appMenu(): readonly NativeSubmenu[] | null {
    return this.#appMenu
  }
}

export function createTestAppMenuHost(): TestAppMenuHost {
  return new TestAppMenuHostImpl()
}
