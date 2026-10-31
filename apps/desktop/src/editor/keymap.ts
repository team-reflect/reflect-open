import { EDITOR_KEY_BINDINGS } from '@meowdown/core'

/**
 * The central keymap registry (Plan 05 step 9). Every shortcut the app binds —
 * editor formatting and headings (meowdown's, listed in `EDITOR_KEY_BINDINGS`),
 * navigation (Plan 06), `[[` autocomplete (Plan 07), `⌘K` (Plan 08), the AI
 * sidebar (Plan 10) — registers in the app's `KeymapService`, which rejects
 * duplicates so bindings can never silently collide across features. This
 * module holds the editor-scope table; `registerAppKeymaps` in
 * `lib/shortcuts.ts` registers it at boot.
 */

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

export const EDITOR_BINDING_DESCRIPTIONS: Record<string, string> = {
  ...EDITOR_BINDINGS,
  ...REFLECT_EDITOR_BINDINGS,
}
