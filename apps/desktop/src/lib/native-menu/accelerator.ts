/**
 * Converts a keymap-registry binding (`Mod-d`, `Mod-\`, …) into the
 * accelerator string Tauri's menu layer (muda) parses — `CmdOrCtrl+D`,
 * `CmdOrCtrl+\`. Same binding grammar as `lib/keybindings.ts`: ProseMirror
 * style, parts joined by `-`, a trailing `-` meaning the literal `-` key.
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

/** The muda accelerator string for a keymap-registry binding. */
export function bindingToAccelerator(binding: string): string {
  const parts = binding.endsWith('-')
    ? [...binding.slice(0, -1).split('-').filter(Boolean), '-']
    : binding.split('-')

  return parts
    .map((part, index) => {
      const lower = part.toLowerCase()
      if (index < parts.length - 1 && lower in ACCELERATOR_MODIFIERS) {
        return ACCELERATOR_MODIFIERS[lower]
      }
      return part.length === 1 ? part.toUpperCase() : part
    })
    .join('+')
}
