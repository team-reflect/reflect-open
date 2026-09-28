import { EDITOR_KEY_BINDINGS } from '@meowdown/core'
import { isApplePlatform, normalizeBinding } from '@/lib/keybindings.ts'

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
/** Normalized binding → the binding as registered. */
const registeredKeystrokes = new Map<string, string>()

/**
 * Register `bindings` under `scope`, throwing on any already-taken keystroke.
 * Bindings are compared after {@link normalizeBinding}, so `Mod-Alt-1` and
 * `Alt-Mod-1` collide. `Meta` is rejected: it means ⌘ on Apple but the
 * Windows/Super key elsewhere, so bindings spell the command key `Mod`.
 * All-or-nothing: validation happens before any key is committed, so a
 * colliding batch never leaves the registry partially mutated.
 */
export function registerKeymap<T>(
  scope: KeymapScope,
  bindings: Record<string, T>,
): Record<string, T> {
  const apple = isApplePlatform()
  const claimed = new Map<string, string>()
  for (const binding of Object.keys(bindings)) {
    if (binding.split('-').slice(0, -1).includes('Meta')) {
      throw new Error(`keybinding "${binding}" uses Meta; use Mod instead`)
    }
    const keystroke = normalizeBinding(binding, apple)
    const existing = registeredKeystrokes.get(keystroke) ?? claimed.get(keystroke)
    if (existing !== undefined) {
      const owner = registeredBindings.get(existing) ?? scope
      throw new Error(
        `duplicate keybinding "${binding}": already registered by the ${owner} scope as "${existing}"`,
      )
    }
    claimed.set(keystroke, binding)
  }
  for (const [keystroke, binding] of claimed) {
    registeredKeystrokes.set(keystroke, binding)
    registeredBindings.set(binding, scope)
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

/** The editor-scope binding that opens the AI menu on the current selection. */
export const AI_MENU_BINDING = 'Mod-Shift-j'

/**
 * Reflect's own editor-scope bindings (bound via `useKeymap` inside the
 * editor, not by meowdown's engine). Declared here, next to meowdown's, so
 * the shortcuts UI lists them — a feature registering its key elsewhere
 * would fire without ever appearing in the cheat sheet.
 */
const REFLECT_EDITOR_BINDINGS: Record<string, string> = {
  [AI_MENU_BINDING]: 'Open the AI menu on the selection',
}

export const EDITOR_BINDING_DESCRIPTIONS: Record<string, string> = registerKeymap('editor', {
  ...EDITOR_BINDINGS,
  ...REFLECT_EDITOR_BINDINGS,
})
