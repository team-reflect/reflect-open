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
import { useNoteTrash } from '@/lib/notes/use-note-trash'

interface AllNotesTrashDialogProps {
  /** Whether the confirm is shown. */
  open: boolean
  /** Open-state changes the screen owns (the trigger lives there). */
  onOpenChange: (open: boolean) => void
  /**
   * The notes to trash — a snapshot taken when the confirm opened, not the live
   * selection. The delete prunes the selection as it removes rows, so driving
   * the dialog off this stable copy keeps the title from flipping to "0 notes"
   * and keeps a failure message from being yanked away mid-render.
   */
  paths: readonly string[]
  /** Run after a successful trash, so the screen can clear its selection. */
  onTrashed: () => void
}

/**
 * The All Notes bulk-trash confirmation. Owns the delete ({@link useNoteTrash})
 * and its error so the screen only has to track which paths to trash and
 * whether the dialog is open. On success it clears the selection and closes; on
 * failure it stays open with the reason (the rows reappear as the failed delete
 * reconciles). The error is dropped whenever the dialog closes, so a later open
 * never inherits a stale message.
 */
export function AllNotesTrashDialog({
  open,
  onOpenChange,
  paths,
  onTrashed,
}: AllNotesTrashDialogProps): ReactElement {
  const { trash, isTrashing } = useNoteTrash()
  const [error, setError] = useState<string | null>(null)
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const count = paths.length

  const onConfirm = async (): Promise<void> => {
    try {
      await trash(paths)
      setError(null) // a prior failure's message must not survive a later success
      onTrashed()
      onOpenChange(false)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (isTrashing) {
          return // a trash in flight owns the dialog until it settles
        }
        if (!next) {
          setError(null)
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
        {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
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
