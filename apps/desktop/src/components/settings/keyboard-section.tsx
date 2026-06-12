import type { ReactElement } from 'react'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { formatBindingLabel } from '@/lib/keybindings'
import { APP_SHORTCUTS, EDITOR_SHORTCUTS, type Shortcut } from '@/lib/shortcuts'
import { SettingsSection } from './section'

function ShortcutGroup({
  heading,
  shortcuts,
}: {
  heading: string
  shortcuts: Shortcut[]
}): ReactElement {
  return (
    <div className="px-4 py-3.5">
      <h3 className="text-[11px] font-semibold tracking-[0.08em] text-text-muted uppercase">
        {heading}
      </h3>
      <ul className="mt-1.5">
        {shortcuts.map(({ binding, description }) => (
          <li
            key={binding}
            className="flex items-center justify-between gap-4 py-1.5 text-sm text-text-secondary"
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
    <SettingsSection id="keyboard">
      <ShortcutGroup heading="App" shortcuts={APP_SHORTCUTS} />
      <ShortcutGroup heading="Editor" shortcuts={EDITOR_SHORTCUTS} />
    </SettingsSection>
  )
}
