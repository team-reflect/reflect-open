import type { PlatformFacts } from '@reflect/core'
import { formatBinding, normalizeBinding } from './keybindings.ts'

export type KeymapScope = 'editor' | 'app'

/**
 * The central keymap registry. Every shortcut the app binds registers
 * through {@link KeymapService.register}, which rejects duplicates so
 * bindings can never silently collide across features.
 */
export interface KeymapService {
  /**
   * Register `bindings` under `scope` and return them, throwing on any
   * already-taken keystroke. Bindings are compared after `normalizeBinding`,
   * so `Mod-Alt-1` and `Alt-Mod-1` collide. `Meta` is rejected: it means ⌘ on
   * Apple but the Windows/Super key elsewhere, so bindings spell the command
   * key `Mod`. All-or-nothing: validation happens before any key is
   * committed, so a colliding batch never leaves the registry partially
   * mutated.
   */
  register<T>(scope: KeymapScope, bindings: Record<string, T>): Record<string, T>
  /**
   * Every registered binding, as registered.
   */
  list(): ReadonlyMap<string, KeymapScope>
  /**
   * One plain-text label for tooltips and AT, e.g. `⌘D` on Apple, `Ctrl+D` elsewhere.
   */
  formatLabel(binding: string): string
}

export interface KeymapServiceDeps {
  readonly platform: PlatformFacts
}

class KeymapServiceImpl implements KeymapService {
  readonly #deps: KeymapServiceDeps
  readonly #registeredBindings = new Map<string, KeymapScope>()
  /**
   * Normalized binding → the binding as registered.
   */
  readonly #registeredKeystrokes = new Map<string, string>()

  constructor(deps: KeymapServiceDeps) {
    this.#deps = deps
  }

  register<T>(scope: KeymapScope, bindings: Record<string, T>): Record<string, T> {
    const apple = this.#deps.platform.isApplePlatform
    const claimed = new Map<string, string>()
    for (const binding of Object.keys(bindings)) {
      if (binding.split('-').slice(0, -1).includes('Meta')) {
        throw new Error(`keybinding "${binding}" uses Meta; use Mod instead`)
      }
      const keystroke = normalizeBinding(binding, apple)
      const existing = this.#registeredKeystrokes.get(keystroke) ?? claimed.get(keystroke)
      if (existing !== undefined) {
        const owner = this.#registeredBindings.get(existing) ?? scope
        throw new Error(
          `duplicate keybinding "${binding}": already registered by the ${owner} scope as "${existing}"`,
        )
      }
      claimed.set(keystroke, binding)
    }
    for (const [keystroke, binding] of claimed) {
      this.#registeredKeystrokes.set(keystroke, binding)
      this.#registeredBindings.set(binding, scope)
    }
    return bindings
  }

  list(): ReadonlyMap<string, KeymapScope> {
    return this.#registeredBindings
  }

  formatLabel(binding: string): string {
    const apple = this.#deps.platform.isApplePlatform
    return formatBinding(binding, apple).join(apple ? '' : '+')
  }
}

export function createKeymapService(deps: KeymapServiceDeps): KeymapService {
  return new KeymapServiceImpl(deps)
}
