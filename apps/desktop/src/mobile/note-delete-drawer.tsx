import { useRef, useState, type ReactElement } from 'react'
import { errorMessage } from '@reflect/core'
import { Button } from '@/components/ui/button'
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from '@/components/ui/drawer'
import { deleteOpenNote } from '@/lib/note-delete'
import { useGraph } from '@/providers/graph-provider'

interface NoteDeleteDrawerProps {
  /** Graph-relative path of the regular note to move to trash. */
  path: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after the note is safely in trash. */
  onDeleted: () => void
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
  const { graph } = useGraph()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submittingRef = useRef(false)

  const handleOpenChange = (next: boolean): void => {
    if (!busy) {
      setError(null)
      onOpenChange(next)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (submittingRef.current) {
      return
    }
    if (graph === null) {
      setError('No graph is open.')
      return
    }
    submittingRef.current = true
    setBusy(true)
    setError(null)
    try {
      await deleteOpenNote(path, graph.generation)
      onOpenChange(false)
      onDeleted()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      submittingRef.current = false
      setBusy(false)
    }
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
          {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
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
              className="w-full"
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
