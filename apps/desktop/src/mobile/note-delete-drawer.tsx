import type { ReactElement } from 'react'
import { Button } from '@/components/ui/button.tsx'
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from '@/components/ui/drawer.tsx'
import { useAsyncAction } from '@/hooks/use-async-action.ts'
import { useCoreServices } from '@/services/services-provider.tsx'

interface NoteDeleteDrawerProps {
  /** Graph-relative path of the regular note to move to trash. */
  path: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after the note is safely in trash. */
  onDeleted?: () => void
}

/**
 * The shared mobile delete confirmation. A note is recoverable from the
 * graph-local trash on desktop, but mobile has no recovery UI, so both the
 * note screen and list swipe action confirm in a touch-native bottom drawer.
 */
export function NoteDeleteDrawer({
  path,
  open,
  onOpenChange,
  onDeleted,
}: NoteDeleteDrawerProps): ReactElement {
  const { noteActions } = useCoreServices()
  const { run, pending: busy, error, reset } = useAsyncAction()

  const handleOpenChange = (next: boolean): void => {
    if (!busy) {
      reset()
      onOpenChange(next)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    await run(async () => {
      await noteActions.trashOne(path)
      onOpenChange(false)
      onDeleted?.()
    })
  }

  return (
    <Drawer open={open} onOpenChange={handleOpenChange}>
      <DrawerContent aria-label="Delete note confirmation">
        <DrawerTitle>Delete this note?</DrawerTitle>
        <DrawerBody>
          <DrawerDescription>
            It moves to the graph’s trash and disappears from your notes. You can recover it on
            desktop.
          </DrawerDescription>
          {error !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-col gap-2 pt-2">
            <Button
              variant="destructive"
              className="w-full"
              disabled={busy}
              onClick={() => void confirmDelete()}
            >
              Delete
            </Button>
            <Button
              variant="ghost"
              className="h-12 w-full text-base"
              disabled={busy}
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
          </div>
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  )
}
