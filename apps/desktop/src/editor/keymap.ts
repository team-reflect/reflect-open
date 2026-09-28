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

interface ChordOwner {
  binding: string
  scope: KeymapScope
}

const registeredBindings = new Map<string, KeymapScope>()
const registeredChords = new Map<string, ChordOwner>()

/**
 * The concrete keystrokes a binding can mean, modifiers in a canonical order.
 * `Mod` is ⌘ on macOS and Ctrl elsewhere, so `Mod-1` and `Meta-1` are the same
 * keystroke on a Mac and must collide even though the strings differ.
 */
function chordsFor(binding: string): string[] {
  // Search from the second-to-last character so a trailing `-` key
  // (`Mod--`) stays the key rather than a separator.
  const separator = binding.lastIndexOf('-', binding.length - 2)
  const key = binding.slice(separator + 1)
  const modifiers = separator < 0 ? [] : binding.slice(0, separator).split('-')
  const platforms = modifiers.includes('Mod') ? ['Meta', 'Ctrl'] : [null]
  return platforms.map((platformModifier) => {
    const resolved = modifiers.map((modifier) =>
      modifier === 'Mod' && platformModifier !== null ? platformModifier : modifier,
    )
    return [...new Set(resolved)].sort().concat(key).join('-')
  })
}

/**
 * Register `bindings` under `scope`, throwing on any already-taken keystroke.
 * All-or-nothing: validation happens before any key is committed, so a
 * colliding batch never leaves the registry partially mutated.
 */
export function registerKeymap<T>(
  scope: KeymapScope,
  bindings: Record<string, T>,
): Record<string, T> {
  const claimed = new Map<string, ChordOwner>()
  for (const binding of Object.keys(bindings)) {
    for (const chord of chordsFor(binding)) {
      const existing = registeredChords.get(chord) ?? claimed.get(chord)
      if (existing) {
        throw new Error(
          `duplicate keybinding "${binding}": already registered by the ${existing.scope} scope as "${existing.binding}"`,
        )
      }
      claimed.set(chord, { binding, scope })
    }
  }
  for (const [chord, owner] of claimed) {
    registeredChords.set(chord, owner)
    registeredBindings.set(owner.binding, scope)
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

/**
 * meowdown bindings the app takes over outright. ⌘1–⌘9 switch graphs from
 * anywhere, including a focused editor (`graph.switchN` dispatches ahead of
 * it), so meowdown's `Mod-1`–`Mod-6` heading toggles never fire on macOS and
 * are not listed as editor shortcuts.
 */
const OVERRIDDEN_BY_APP: ReadonlySet<string> = new Set([
  'Mod-1',
  'Mod-2',
  'Mod-3',
  'Mod-4',
  'Mod-5',
  'Mod-6',
])

const EDITOR_BINDINGS = Object.fromEntries(
  Object.entries(EDITOR_KEY_BINDINGS).filter(
    ([key]) => !SHARED_WITH_APP.has(key) && !OVERRIDDEN_BY_APP.has(key),
  ),
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
