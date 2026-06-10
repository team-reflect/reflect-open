import type { ReactElement } from 'react'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { EDITOR_BINDING_DESCRIPTIONS } from '@/editor/keymap'
import { APP_COMMANDS } from '@/lib/commands/app-commands'
import { formatBindingLabel } from '@/lib/keybindings'
import { SettingsSection } from './section'

interface Shortcut {
  binding: string
  description: string
}

/** Both keymap scopes, straight from their registries — never hand-listed. */
const APP_SHORTCUTS: Shortcut[] = APP_COMMANDS.flatMap((command) =>
  command.keybinding ? [{ binding: command.keybinding, description: command.title }] : [],
)
const EDITOR_SHORTCUTS: Shortcut[] = Object.entries(EDITOR_BINDING_DESCRIPTIONS).map(
  ([binding, description]) => ({ binding, description }),
)

function ShortcutGroup({
  heading,
  shortcuts,
}: {
  heading: string
  shortcuts: Shortcut[]
}): ReactElement {
  return (
    <div className="px-4 py-3.5">
      <h3 className="text-[11px] font-semibold tracking-[0.08em] text-[color:var(--text-muted)] uppercase">
        {heading}
      </h3>
      <ul className="mt-1.5">
        {shortcuts.map(({ binding, description }) => (
          <li
            key={binding}
            className="flex items-center justify-between gap-4 py-1.5 text-sm text-[color:var(--text-secondary)]"
          >
            <span className="min-w-0 truncate">{description}</span>
            {/* The keycaps are aria-hidden decoration; this carries the binding for AT. */}
            <span className="sr-only">{formatBindingLabel(binding)}</span>
            <ShortcutKeys binding={binding} />
          </li>
        ))}
      </ul>
    </div>
  )
}

export function KeyboardSection(): ReactElement {
  return (
    <SettingsSection title="Keyboard shortcuts">
      <ShortcutGroup heading="App" shortcuts={APP_SHORTCUTS} />
      <ShortcutGroup heading="Editor" shortcuts={EDITOR_SHORTCUTS} />
    </SettingsSection>
  )
}
