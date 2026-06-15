import { EDITOR_KEY_BINDINGS } from '@meowdown/core'

/**
 * The central keymap registry (Plan 05 step 9). Every shortcut the app binds —
 * editor formatting and headings (meowdown's, listed in `EDITOR_KEY_BINDINGS`),
 * navigation (Plan 06), `[[` autocomplete (Plan 07), `⌘K` (Plan 08), the AI
 * sidebar (Plan 10) — registers through {@link registerKeymap}, which rejects
 * duplicates so bindings can never silently collide across features.
 * Registration happens once at module scope.
 */

export type KeymapScope = 'editor' | 'app'

const registeredBindings = new Map<string, KeymapScope>()

/**
 * Register `bindings` under `scope`, throwing on any already-taken key.
 * All-or-nothing: validation happens before any key is committed, so a
 * colliding batch never leaves the registry partially mutated.
 */
export function registerKeymap<T>(
  scope: KeymapScope,
  bindings: Record<string, T>,
): Record<string, T> {
  const keys = Object.keys(bindings)
  for (const key of keys) {
    const existing = registeredBindings.get(key)
    if (existing) {
      throw new Error(`duplicate keybinding "${key}": already registered by the ${existing} scope`)
    }
  }
  for (const key of keys) {
    registeredBindings.set(key, scope)
  }
  return bindings
}

/** Every registered binding (for the collision test + a future shortcuts UI). */
export function listRegisteredBindings(): ReadonlyMap<string, KeymapScope> {
  return registeredBindings
}

/**
 * Display descriptions for the editor-scope bindings (the shortcuts UI). The
 * editor's keymap lives in meowdown's engine; Reflect only claims those keys
 * editor-scope so no app binding can shadow them, and lists them in the
 * Keyboard settings section.
 */
export const EDITOR_BINDING_DESCRIPTIONS: Record<string, string> = registerKeymap('editor', {
  ...EDITOR_KEY_BINDINGS,
})
