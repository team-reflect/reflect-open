import { useRef, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import { useNoteTrash } from '@/lib/notes/use-note-trash'

interface AllNotesTrashDialogProps {
  /** Whether the confirm is shown. */
  open: boolean
  /** Open-state changes the screen owns (the trigger lives there). */
  onOpenChange: (open: boolean) => void
  /**
   * The notes to trash — a snapshot taken when the confirm opened, not the live
   * selection. The delete prunes the selection as it removes rows, so driving
   * the dialog off this stable copy keeps the title from flipping to "0 notes".
   */
  paths: readonly string[]
  /** Run after every note is trashed, so the screen can clear its selection. */
  onTrashed: () => void
}

/**
 * The All Notes bulk-trash confirmation. Owns the delete ({@link useNoteTrash})
 * so the screen only tracks which paths to trash and whether the dialog is open.
 *
 * It always closes on confirm: on full success it clears the selection, and on
 * any failure it leaves the selection alone — the notes that didn't trash stay
 * in the list and selected, ready to retry — and lets {@link useNoteTrash}
 * report the reason through the operations toast, the app's standard channel for
 * background-work failures. No inline error, no in-dialog retry.
 */
export function AllNotesTrashDialog({
  open,
  onOpenChange,
  paths,
  onTrashed,
}: AllNotesTrashDialogProps): ReactElement {
  const { trash, isTrashing } = useNoteTrash()
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const count = paths.length

  const onConfirm = async (): Promise<void> => {
    const trashed = await trash(paths)
    onOpenChange(false)
    if (trashed) {
      onTrashed()
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (isTrashing) {
          return // a trash in flight owns the dialog until it settles
        }
        onOpenChange(next)
      }}
    >
      <DialogContent
        onOpenAutoFocus={(event) => {
          // Focus the confirm action so ⌘⌫ → Return completes from the keyboard.
          event.preventDefault()
          confirmButtonRef.current?.focus()
        }}
      >
        <DialogTitle>
          Trash {count} {count === 1 ? 'note' : 'notes'}?
        </DialogTitle>
        <DialogDescription>
          {count === 1 ? 'It moves' : 'They move'} to your system Trash, where you can restore{' '}
          {count === 1 ? 'it' : 'them'}.
        </DialogDescription>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={isTrashing}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            ref={confirmButtonRef}
            variant="destructive"
            disabled={isTrashing}
            onClick={() => void onConfirm()}
          >
            Trash
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
