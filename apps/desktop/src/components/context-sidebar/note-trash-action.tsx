import { useState, type ReactElement } from 'react'
import { errorMessage, isDaily } from '@reflect/core'
import { Trash2 } from 'lucide-react'
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
import { startOperation } from '@/lib/operations'
import { useGraph } from '@/providers/graph-provider'
import { useRouter } from '@/routing/router'

interface NoteTrashActionProps {
  /** Graph-relative path of the regular note to move into trash. */
  path: string
}

/**
 * Moves a regular note to the graph-local trash after confirmation. Daily
 * notes return `null` here as a second UI-layer guard; the shared delete helper
 * enforces the same rule before touching disk.
 */
export function NoteTrashAction({ path }: NoteTrashActionProps): ReactElement | null {
  const { graph } = useGraph()
  const { navigate } = useRouter()
  const [confirmingTrash, setConfirmingTrash] = useState(false)
  const [isTrashing, setIsTrashing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (isDaily(path)) {
    return null
  }

  const onTrash = async (): Promise<void> => {
    const generation = graph?.generation
    if (generation === undefined) {
      return
    }
    const operation = startOperation('Trashing note')
    setIsTrashing(true)
    setError(null)
    try {
      await deleteOpenNote(path, generation)
      operation.done()
      setConfirmingTrash(false)
      navigate({ kind: 'today' })
    } catch (cause) {
      const message = errorMessage(cause)
      setError(message)
      operation.fail(message)
    } finally {
      setIsTrashing(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirmingTrash(true)}
        className="group relative flex w-full items-center space-x-2 rounded-lg px-3 py-2 text-start transition-colors duration-100 hover:bg-surface-hover"
      >
        <span className="flex h-5 w-5 flex-none items-center justify-center text-text-muted transition-colors duration-100 group-hover:text-destructive">
          <Trash2 size={14} aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium transition-colors duration-100 group-hover:text-destructive">
          Trash note
        </span>
      </button>

      <Dialog open={confirmingTrash} onOpenChange={(open) => !isTrashing && setConfirmingTrash(open)}>
        <DialogContent>
          <DialogTitle>Trash this note?</DialogTitle>
          <DialogDescription>
            It moves to your system Trash, where you can restore it.
          </DialogDescription>
          {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" disabled={isTrashing}>
                Cancel
              </Button>
            </DialogClose>
            <Button variant="destructive" disabled={isTrashing} onClick={() => void onTrash()}>
              Trash note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
