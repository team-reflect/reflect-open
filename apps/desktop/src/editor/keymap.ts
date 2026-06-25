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
 *
 * `Mod-k` is the deliberate exception: it is shared, not reserved editor-scope.
 * meowdown consumes it inside the editor only when there is a selection or a link
 * at the caret (to insert or edit a link); otherwise it lets the keydown fall
 * through to the app command palette, which claims `Mod-k` app-scope. The editor
 * wins at run time by preventDefault-ing the keydown it handles, which
 * `useAppShortcuts` checks before acting.
 */
const SHARED_WITH_APP: ReadonlySet<string> = new Set(['Mod-k'])

const EDITOR_BINDINGS = Object.fromEntries(
  Object.entries(EDITOR_KEY_BINDINGS).filter(([key]) => !SHARED_WITH_APP.has(key)),
)

export const EDITOR_BINDING_DESCRIPTIONS: Record<string, string> = registerKeymap(
  'editor',
  EDITOR_BINDINGS,
)
