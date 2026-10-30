import { useCallback, type ReactElement } from 'react'
import { ConfirmActionDialog } from '@/components/confirm-action-dialog.tsx'
import { useNoteTrash } from '@/lib/notes/use-note-trash.ts'

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
}: AllNotesTrashDialogProps): ReactElement | null {
  const { trash } = useNoteTrash()
  const count = paths.length

  // `trash` never rejects (failures go to the operations toast), so the
  // dialog always closes when it settles.
  const confirm = useCallback(async (): Promise<void> => {
    if (await trash(paths)) {
      onTrashed()
    }
  }, [trash, paths, onTrashed])
  const close = useCallback(() => onOpenChange(false), [onOpenChange])

  if (!open) {
    return null
  }

  return (
    <ConfirmActionDialog
      title={`Trash ${count} ${count === 1 ? 'note' : 'notes'}?`}
      description={`${count === 1 ? 'It moves' : 'They move'} to your system Trash, where you can restore ${count === 1 ? 'it' : 'them'}.`}
      confirmLabel="Trash"
      pendingLabel="Trashing…"
      variant="destructive"
      focusConfirm
      onConfirm={confirm}
      onClose={close}
    />
  )
}
