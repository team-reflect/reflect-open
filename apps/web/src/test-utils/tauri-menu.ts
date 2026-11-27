import { vi } from 'vitest'

/**
 * The host calls that `setAsAppMenu` and the NSApp role setters make, in order.
 */
export const menuCalls: string[] = []
/**
 * The text (or kind) of every closed resource, in order.
 */
export const closedMenus: string[] = []

export const popup = vi.fn(async () => {})
export const setAsAppMenu = vi.fn(() => {
  menuCalls.push('setAsAppMenu')
  return Promise.resolve()
})

interface ResourceOptions {
  text?: string
  action?: () => void
}

/**
 * Fake methods live on the prototype, so `toEqual` compares only the echoed options and `built`.
 */
class FakeResource {
  readonly #name: string
  constructor(kind: string, options: ResourceOptions) {
    Object.assign(this, options, { built: kind })
    this.#name = options.text ?? kind
  }
  close(): Promise<void> {
    closedMenus.push(this.#name)
    return Promise.resolve()
  }
}

class FakeSubmenu extends FakeResource {
  readonly #text: string | undefined
  constructor(options: ResourceOptions) {
    super('Submenu', options)
    this.#text = options.text
  }
  setAsWindowsMenuForNSApp(): Promise<void> {
    menuCalls.push(`windows:${this.#text}`)
    return Promise.resolve()
  }
  setAsHelpMenuForNSApp(): Promise<void> {
    menuCalls.push(`help:${this.#text}`)
    return Promise.resolve()
  }
}

function fakeResourceNew(kind: string) {
  return vi.fn((options: ResourceOptions) => {
    return Promise.resolve(
      kind === 'Submenu' ? new FakeSubmenu(options) : new FakeResource(kind, options),
    )
  })
}

export const menuNew = vi.fn((_options: unknown) => {
  return Promise.resolve({ setAsAppMenu, popup, close: () => void closedMenus.push('Menu') })
})
export const menuItemNew = fakeResourceNew('MenuItem')
export const checkMenuItemNew = fakeResourceNew('CheckMenuItem')
export const submenuNew = fakeResourceNew('Submenu')

/**
 * A stand-in for `@tauri-apps/api/menu`. Mock it with
 * `vi.mock('@tauri-apps/api/menu', () => import('@/test-utils/tauri-menu.ts'))`.
 */
export const Menu = { new: menuNew }
export const MenuItem = { new: menuItemNew }
export const CheckMenuItem = { new: checkMenuItemNew }
export const Submenu = { new: submenuNew }

export function resetFakeTauriMenu(): void {
  vi.clearAllMocks()
  menuCalls.length = 0
  closedMenus.length = 0
}
