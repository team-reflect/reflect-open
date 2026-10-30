import { useCallback, useState, type ReactElement } from 'react'
import { canTrashNote, errorMessage } from '@reflect/core'
import { Trash2 } from 'lucide-react'
import { ConfirmActionDialog } from '@/components/confirm-action-dialog.tsx'
import { useRouter } from '@/routing/router.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

interface NoteTrashActionProps {
  /** Graph-relative path of the regular note to move into trash. */
  path: string
}

/**
 * Moves a regular note to the system Trash after confirmation. Daily notes
 * return `null` here as a second UI-layer guard; the shared delete helper
 * enforces the same rule before touching disk.
 */
export function NoteTrashAction({ path }: NoteTrashActionProps): ReactElement | null {
  const { navigate } = useRouter()
  const { noteActions } = useCoreServices()
  const { operations } = useAppServices()
  const [confirmingTrash, setConfirmingTrash] = useState(false)

  const trash = useCallback(async (): Promise<void> => {
    const operation = operations.start('Trashing note')
    try {
      await noteActions.trashOne(path)
    } catch (cause) {
      operation.fail(errorMessage(cause))
      throw cause
    }
    operation.done()
    navigate({ kind: 'today' })
  }, [operations, noteActions, path, navigate])
  const closeConfirm = useCallback(() => setConfirmingTrash(false), [])

  if (!canTrashNote(path)) {
    return null
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirmingTrash(true)}
        className="group relative flex w-full items-center space-x-2 rounded-lg px-3 py-2 text-start hover:bg-surface-hover"
      >
        <span className="flex h-5 w-5 flex-none items-center justify-center text-text-muted group-hover:text-destructive">
          <Trash2 size={14} aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium group-hover:text-destructive">
          Trash note
        </span>
      </button>

      {confirmingTrash ? (
        <ConfirmActionDialog
          title="Trash this note?"
          description="It moves to your system Trash, where you can restore it."
          confirmLabel="Trash note"
          pendingLabel="Trashing…"
          variant="destructive"
          onConfirm={trash}
          onClose={closeConfirm}
        />
      ) : null}
    </>
  )
}
