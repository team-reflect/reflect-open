import { useState, type ReactElement } from 'react'
import { canTrashNote, errorMessage } from '@reflect/core'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog.tsx'
import { useAsyncAction } from '@/hooks/use-async-action.ts'
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
  const trashAction = useAsyncAction()

  if (!canTrashNote(path)) {
    return null
  }

  const onTrash = async (): Promise<void> => {
    await trashAction.run(async () => {
      const operation = operations.start('Trashing note')
      try {
        await noteActions.trashOne(path)
        operation.done()
        setConfirmingTrash(false)
        navigate({ kind: 'today' })
      } catch (cause) {
        operation.fail(errorMessage(cause))
        // Rethrown so `trashAction.error` shows it in the dialog.
        throw cause
      }
    })
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

      <Dialog
        open={confirmingTrash}
        onOpenChange={(open) => !trashAction.pending && setConfirmingTrash(open)}
      >
        <DialogContent>
          <DialogTitle>Trash this note?</DialogTitle>
          <DialogDescription>
            It moves to your system Trash, where you can restore it.
          </DialogDescription>
          {trashAction.error !== null ? (
            <p className="text-sm text-destructive">{trashAction.error}</p>
          ) : null}
          <DialogFooter>
            <DialogClose
              render={
                <Button variant="ghost" disabled={trashAction.pending}>
                  Cancel
                </Button>
              }
            />
            <Button
              variant="destructive"
              disabled={trashAction.pending}
              onClick={() => void onTrash()}
            >
              Trash note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
