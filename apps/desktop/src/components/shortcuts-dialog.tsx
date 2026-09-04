import type { ReactElement } from 'react'
import { createDeferredFeature } from '@/components/deferred-feature'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useShortcuts } from '@/providers/shortcuts-provider'

const ShortcutDialogContent = createDeferredFeature(
  async () => ({ default: (await import('./shortcut-dialog-content')).ShortcutDialogContent }),
  { name: 'keyboard shortcuts' },
)

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
        <ShortcutDialogContent />
      </DialogContent>
    </Dialog>
  )
}
