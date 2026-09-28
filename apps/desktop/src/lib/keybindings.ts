/**
 * Display formatting for keymap-registry bindings (`Mod-d`, `Mod-\`, …).
 *
 * The registry's binding strings are ProseMirror-style — modifiers and a final
 * key joined by `-`. This module turns one into the per-key labels a keycap
 * row renders: platform symbols on Apple (⌘ ⇧ ⌥ ⌃), words elsewhere
 * (Ctrl, Shift, Alt). Pure functions so the mapping is unit-testable; the
 * platform check is separated out for components to call once.
 */

const APPLE_MODIFIERS: Record<string, string> = {
  mod: '⌘',
  meta: '⌘',
  shift: '⇧',
  alt: '⌥',
  ctrl: '⌃',
}

const GENERIC_MODIFIERS: Record<string, string> = {
  mod: 'Ctrl',
  meta: 'Win',
  shift: 'Shift',
  alt: 'Alt',
  ctrl: 'Ctrl',
}

/** Named keys that read better as symbols (both platforms). */
const KEY_SYMBOLS: Record<string, string> = {
  enter: '↩',
  backspace: '⌫',
  escape: 'esc',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  space: '␣',
  tab: '⇥',
}

/** True on macOS/iOS — where Mod renders as ⌘ rather than Ctrl. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false
  }
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
}

const MODIFIER_ORDER = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift']

/**
 * The canonical spelling of a binding, so bindings that mean the same
 * keystroke compare equal as strings. `Mod` is ⌘ on Apple and Ctrl elsewhere,
 * so the platform's command key is spelled `Mod`; modifiers take one fixed
 * order and a letter key is lowercase. `Alt-Mod-L` becomes `Mod-Alt-l`, and on
 * Apple a ⌘1 keydown (`Meta-1`) becomes `Mod-1`.
 */
export function normalizeBinding(binding: string, apple: boolean): string {
  const separator = binding.lastIndexOf('-', binding.length - 2)
  const key = binding.slice(separator + 1)
  const modifiers = new Set(separator < 0 ? [] : binding.slice(0, separator).split('-'))
  for (const modifier of modifiers) {
    if (!MODIFIER_ORDER.includes(modifier)) {
      throw new Error(`unknown modifier "${modifier}" in keybinding "${binding}"`)
    }
  }
  if (modifiers.delete(apple ? 'Meta' : 'Ctrl')) {
    modifiers.add('Mod')
  }
  return [
    ...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)),
    key.length === 1 ? key.toLowerCase() : key,
  ].join('-')
}

/** One plain-text label for tooltips and AT, e.g. `⌘D` on Apple, `Ctrl+D` elsewhere. */
export function formatBindingLabel(binding: string): string {
  const apple = isApplePlatform()
  return formatBinding(binding, apple).join(apple ? '' : '+')
}

/**
 * Split a binding into display labels, one per key, modifiers first.
 * A trailing `-` is the literal `-` key (`Mod--`), not a separator.
 */
export function formatBinding(binding: string, apple: boolean): string[] {
  const modifiers = apple ? APPLE_MODIFIERS : GENERIC_MODIFIERS
  const parts = binding.endsWith('-')
    ? [...binding.slice(0, -1).split('-').filter(Boolean), '-']
    : binding.split('-')

  return parts.map((part, index) => {
    const lower = part.toLowerCase()
    if (index < parts.length - 1 && lower in modifiers) {
      return modifiers[lower]!
    }
    if (lower in KEY_SYMBOLS) {
      return KEY_SYMBOLS[lower]!
    }
    return part.length === 1 ? part.toUpperCase() : part
  })
}
