import type { ReactElement } from 'react'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatBindingLabel } from '@/lib/keybindings'
import { APP_SHORTCUTS, EDITOR_SHORTCUTS, type Shortcut } from '@/lib/shortcuts'
import { useShortcuts } from '@/providers/shortcuts-provider'

function ShortcutColumn({
  heading,
  shortcuts,
}: {
  heading: string
  shortcuts: Shortcut[]
}): ReactElement {
  return (
    <div>
      <h3 className="text-[11px] font-semibold tracking-[0.08em] text-text-muted uppercase">
        {heading}
      </h3>
      <ul className="mt-1.5">
        {shortcuts.map(({ binding, description }) => (
          <li
            key={binding}
            className="flex items-center justify-between gap-4 py-1 text-sm text-text-secondary"
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

/**
 * The ⌘/ cheat-sheet (Plan 15): every registered binding from both keymap
 * scopes, in one glanceable dialog. The lists derive from the same registries
 * the bindings fire from, so the sheet can never advertise a dead shortcut.
 */
export function ShortcutsDialog(): ReactElement {
  const { open, closeShortcuts } = useShortcuts()

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          closeShortcuts()
        }
      }}
    >
      {/* No description: the title + lists are the whole content. */}
      <DialogContent aria-describedby={undefined} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <div className="grid gap-6 sm:grid-cols-2">
          <ShortcutColumn heading="App" shortcuts={APP_SHORTCUTS} />
          <ShortcutColumn heading="Editor" shortcuts={EDITOR_SHORTCUTS} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
