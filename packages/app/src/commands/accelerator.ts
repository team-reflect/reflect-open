import type { MainMenuKeyEquivalent, MainMenuModifier, MainMenuNamedKey } from '@reflect/core'

/**
 * Converts a keymap-registry binding (`Mod-d`, `Mod-\`, …) into the
 * accelerator string Tauri's menu layer (muda) parses — `CmdOrCtrl+D`,
 * `CmdOrCtrl+\` — or into the iPadOS menu bar's key equivalent. Same binding
 * grammar as `keybindings.ts`: ProseMirror style, parts joined by `-`, a
 * trailing `-` meaning the literal `-` key.
 *
 * muda accepts single letters and punctuation verbatim (`[`, `]`, `\`, `,`,
 * `/`) plus named keys like `Enter`, so the key part passes through; only the
 * modifiers need translating.
 */

const ACCELERATOR_MODIFIERS: Record<string, string> = {
  mod: 'CmdOrCtrl',
  meta: 'Cmd',
  shift: 'Shift',
  alt: 'Alt',
  ctrl: 'Ctrl',
}

const KEY_EQUIVALENT_MODIFIERS: Record<string, MainMenuModifier> = {
  mod: 'command',
  meta: 'command',
  shift: 'shift',
  alt: 'alternate',
  ctrl: 'control',
}

// Space is a character to UIKit, so it maps to one rather than to a name.
const KEY_EQUIVALENT_NAMED_INPUTS: Record<string, MainMenuNamedKey | ' '> = {
  enter: 'enter',
  escape: 'escape',
  tab: 'tab',
  backspace: 'delete',
  arrowup: 'upArrow',
  arrowdown: 'downArrow',
  arrowleft: 'leftArrow',
  arrowright: 'rightArrow',
  space: ' ',
}

function bindingParts(binding: string): string[] {
  return binding.endsWith('-')
    ? [...binding.slice(0, -1).split('-').filter(Boolean), '-']
    : binding.split('-')
}

/**
 * The iPadOS `UIKeyCommand` key equivalent for a keymap-registry binding, in
 * the grammar of `tauri-plugin-native-menu`: `Mod` is ⌘ (the menu bar only
 * exists on Apple platforms), letters are lowercase, and named keys use the
 * plugin's names. `null` for a key the menu bar cannot express.
 */
export function bindingToKeyEquivalent(binding: string): MainMenuKeyEquivalent | null {
  const parts = bindingParts(binding)
  const key = parts.at(-1)
  if (key === undefined || key === '') {
    return null
  }
  const modifiers: MainMenuModifier[] = []
  for (const part of parts.slice(0, -1)) {
    const lower = part.toLowerCase()
    if (!Object.hasOwn(KEY_EQUIVALENT_MODIFIERS, lower)) {
      return null
    }
    const modifier = KEY_EQUIVALENT_MODIFIERS[lower]
    if (modifier !== undefined && !modifiers.includes(modifier)) {
      modifiers.push(modifier)
    }
  }
  if (key.length === 1) {
    return { input: key.toLowerCase(), modifiers }
  }
  const named = Object.hasOwn(KEY_EQUIVALENT_NAMED_INPUTS, key.toLowerCase())
    ? KEY_EQUIVALENT_NAMED_INPUTS[key.toLowerCase()]
    : undefined
  return named === undefined ? null : { input: named, modifiers }
}

/** The muda accelerator string for a keymap-registry binding. */
export function bindingToAccelerator(binding: string): string {
  const parts = bindingParts(binding)
  return parts
    .map((part, index) => {
      const lower = part.toLowerCase()
      if (index < parts.length - 1 && Object.hasOwn(ACCELERATOR_MODIFIERS, lower)) {
        return ACCELERATOR_MODIFIERS[lower]
      }
      return part.length === 1 ? part.toUpperCase() : part
    })
    .join('+')
}
