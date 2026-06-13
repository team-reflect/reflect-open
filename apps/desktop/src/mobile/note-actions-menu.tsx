import { useState, type ReactElement } from 'react'
import { MoreHorizontal, Pin, PinOff, Share, Trash2 } from 'lucide-react'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toggleNotePinned } from '@/lib/note-pin'
import { deleteOpenNote } from '@/mobile/note-delete'
import { shareNote } from '@/mobile/share'
import { useGraph } from '@/providers/graph-provider'
import { usePinnedNotes } from '@/hooks/use-pinned-notes'

interface NoteActionsMenuProps {
  /** Graph-relative path of the note the actions operate on. */
  path: string
  /** Called after the note is deleted, so the screen can navigate away. */
  onDeleted: () => void
}

/**
 * The note screen's "⋯" actions menu (Plan 19, V1 parity): pin/unpin, share,
 * and delete-to-trash. Pin reflects the index's pinned set; {@link shareNote}
 * hands the note's body to the OS share sheet via the Web Share API
 * (`navigator.share`); delete confirms first (it's destructive, even if
 * recoverable from `.reflect/trash/`) and routes through
 * {@link deleteOpenNote} so the open session is discarded rather than flushed.
 */
export function NoteActionsMenu({ path, onDeleted }: NoteActionsMenuProps): ReactElement {
  const { graph } = useGraph()
  const isPinned = usePinnedNotes().some((note) => note.path === path)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pin = (): void => {
    if (graph !== null) {
      void toggleNotePinned(path, graph.generation).catch(() => {})
    }
  }

  const share = (): void => {
    void shareNote(path).catch((cause) => console.error('share failed:', errorMessage(cause)))
  }

  const confirmDelete = (): void => {
    if (graph === null) {
      return
    }
    setBusy(true)
    setError(null)
    void deleteOpenNote(path, graph.generation)
      .then(() => {
        setConfirmingDelete(false)
        onDeleted()
      })
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setBusy(false))
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-10" aria-label="Note actions">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={pin}>
            {isPinned ? <PinOff /> : <Pin />}
            {isPinned ? 'Unpin' : 'Pin'}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={share}>
            <Share />
            Share
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmingDelete(true)}>
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={confirmingDelete} onOpenChange={(open) => !busy && setConfirmingDelete(open)}>
        <DialogContent>
          <DialogTitle>Delete this note?</DialogTitle>
          <DialogDescription>
            It moves to the graph’s trash and disappears from your notes. You can recover it on
            desktop.
          </DialogDescription>
          {error !== null && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button variant="destructive" disabled={busy} onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
