import { useRef, useState, type ReactElement } from 'react'
import { errorMessage } from '@reflect/core'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import { deleteOpenNote } from '@/lib/note-delete'
import { useGraph } from '@/providers/graph-provider'

interface NoteDeleteDialogProps {
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
 * note screen and list swipe action keep the explicit confirmation.
 */
export function NoteDeleteDialog({
  path,
  open,
  onOpenChange,
  onDeleted,
}: NoteDeleteDialogProps): ReactElement {
  const { graph } = useGraph()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submittingRef = useRef(false)

  const confirmDelete = async (): Promise<void> => {
    if (graph === null || submittingRef.current) {
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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          setError(null)
          onOpenChange(next)
        }
      }}
    >
      <DialogContent>
        <DialogTitle>Delete this note?</DialogTitle>
        <DialogDescription>
          It moves to the graph’s trash and disappears from your notes. You can recover it on
          desktop.
        </DialogDescription>
        {error !== null && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <DialogClose
            render={
              <Button variant="ghost" disabled={busy}>
                Cancel
              </Button>
            }
          />
          <Button variant="destructive" disabled={busy} onClick={() => void confirmDelete()}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
