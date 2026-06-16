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
  /** Run after every note is trashed, so the screen can clear its selection. */
  onTrashed: () => void
}

/**
 * The All Notes bulk-trash confirmation. Owns the delete ({@link useNoteTrash})
 * and its error so the screen only tracks which paths to trash and whether the
 * dialog is open.
 *
 * On full success it clears the selection and closes. On a partial failure it
 * narrows its retry set to just the notes that *didn't* trash and stays open —
 * so confirming again retries only the leftovers, never re-deleting notes
 * already in the trash (the OS trash isn't idempotent). A fresh open (a new
 * `paths` array) resets the retry set and clears any prior error.
 */
export function AllNotesTrashDialog({
  open,
  onOpenChange,
  paths,
  onTrashed,
}: AllNotesTrashDialogProps): ReactElement {
  const { trash, isTrashing } = useNoteTrash()
  // The notes the next confirm will attempt: the snapshot, less any already
  // trashed in a prior (partly failed) attempt.
  const [remaining, setRemaining] = useState<readonly string[]>(paths)
  const [syncedPaths, setSyncedPaths] = useState(paths)
  const [error, setError] = useState<string | null>(null)
  const confirmButtonRef = useRef<HTMLButtonElement>(null)

  // A fresh open hands in a new `paths` array (the screen re-snapshots the
  // selection each time): reset the retry set and drop any stale error. Done in
  // render — the React-recommended way to reset state from a changed prop.
  if (paths !== syncedPaths) {
    setSyncedPaths(paths)
    setRemaining(paths)
    setError(null)
  }

  const count = remaining.length

  const onConfirm = async (): Promise<void> => {
    try {
      const failed = await trash(remaining)
      if (failed.length === 0) {
        onTrashed()
        onOpenChange(false)
        return
      }
      // Some notes are now in the trash; keep only the leftovers for the retry.
      setRemaining(failed)
      setError(`Couldn't trash ${failed.length} ${failed.length === 1 ? 'note' : 'notes'}. Try again.`)
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
