import { EDITOR_BINDING_DESCRIPTIONS } from '@/editor/keymap.ts'
import { APP_COMMANDS } from '@/lib/commands/app-commands.ts'
import { isNotNullish } from '@ocavue/utils'
import type { KeymapService } from '@reflect/app'

/** One row of a shortcuts listing: a binding and what it does. */
export interface Shortcut {
  binding: string
  description: string
}

/**
 * Both keymap scopes, straight from their registries — never hand-listed, so
 * the ⌘/ cheat-sheet and the Keyboard settings section can't drift from the
 * bindings that actually fire.
 */
export const APP_SHORTCUTS: Shortcut[] = APP_COMMANDS.map((command) => {
  return command.keybinding ? { binding: command.keybinding, description: command.title } : null
}).filter(isNotNullish)

export const EDITOR_SHORTCUTS: Shortcut[] = Object.entries(EDITOR_BINDING_DESCRIPTIONS).map(
  ([binding, description]) => ({ binding, description }),
)

const registeredIn = new WeakSet<object>()

/**
 * Register both keymap scopes in `keymap`, the collision ledger: a keystroke
 * bound twice, in one scope or across them, throws. Called explicitly from
 * `main.tsx`, like `registerAppCommands`. Idempotent per registry.
 */
export function registerAppKeymaps(keymap: KeymapService): void {
  if (registeredIn.has(keymap)) {
    return
  }
  registeredIn.add(keymap)
  keymap.register('editor', EDITOR_BINDING_DESCRIPTIONS)
  keymap.register(
    'app',
    Object.fromEntries(APP_SHORTCUTS.map(({ binding, description }) => [binding, description])),
  )
}
