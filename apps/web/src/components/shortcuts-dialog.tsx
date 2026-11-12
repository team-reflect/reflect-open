import type { ReactElement } from 'react'
import { ShortcutList } from '@/components/shortcut-list.tsx'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { APP_SHORTCUTS, EDITOR_SHORTCUTS } from '@/lib/shortcuts.ts'
import { useShortcuts } from '@/providers/shortcuts-provider.tsx'

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
      <DialogContent
        aria-describedby={undefined}
        className="grid max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-3xl lg:max-w-5xl xl:max-w-6xl"
      >
        <DialogHeader className="pr-8">
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto pr-1">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,1fr)_minmax(0,2fr)] xl:grid-cols-[minmax(14rem,1fr)_minmax(0,3fr)]">
            <ShortcutList heading="App" shortcuts={APP_SHORTCUTS} />
            <ShortcutList
              heading="Editor"
              shortcuts={EDITOR_SHORTCUTS}
              listClassName="lg:columns-2 xl:columns-3 lg:gap-8"
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
