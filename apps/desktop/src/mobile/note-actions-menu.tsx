import { useState, type ReactElement } from 'react'
import { MoreHorizontal, Pin, PinOff, Share, Trash2 } from 'lucide-react'
import { errorMessage } from '@reflect/core'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer'
import { toggleNotePinned } from '@/lib/note-pin'
import { usePinnedNotes } from '@/hooks/use-pinned-notes'
import { NoteDeleteDialog } from '@/mobile/note-delete-dialog'
import { shareNote } from '@/mobile/share'
import { useGraph } from '@/providers/graph-provider'

interface NoteActionsMenuProps {
  /** Graph-relative path of the note the actions operate on. */
  path: string
  /** Called after the note is deleted, so the screen can navigate away. */
  onDeleted: () => void
}

/**
 * The note screen's "⋯" action sheet (Plan 19): pin/unpin, share,
 * and delete-to-trash. Pin reflects the index's pinned set; {@link shareNote}
 * hands the note's body to the OS share sheet via the Web Share API
 * (`navigator.share`); delete confirms first (it's destructive, even if
 * recoverable from `.reflect/trash/`) and routes through
 * {@link deleteOpenNote} so the open session is discarded rather than flushed.
 */
export function NoteActionsMenu({ path, onDeleted }: NoteActionsMenuProps): ReactElement {
  const { graph } = useGraph()
  const isPinned = usePinnedNotes().some((note) => note.path === path)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const pin = (): void => {
    if (graph !== null) {
      void toggleNotePinned(path, graph.generation).catch(() => {})
    }
  }

  const share = (): void => {
    void shareNote(path).catch((cause) => console.error('share failed:', errorMessage(cause)))
  }

  return (
    <>
      <Drawer open={actionsOpen} onOpenChange={setActionsOpen}>
        <DrawerTrigger
          render={
            <Button variant="ghost" size="icon" className="size-10" aria-label="Note actions" />
          }
        >
          <MoreHorizontal />
        </DrawerTrigger>
        <DrawerContent>
          <DrawerTitle className="sr-only">Note actions</DrawerTitle>
          <div className="flex flex-col gap-1 p-4">
            <Button
              variant="ghost"
              size="lg"
              className="h-12 justify-start gap-3 text-base"
              onClick={() => {
                pin()
                setActionsOpen(false)
              }}
            >
              {isPinned ? <PinOff /> : <Pin />}
              {isPinned ? 'Unpin' : 'Pin'}
            </Button>
            <Button
              variant="ghost"
              size="lg"
              className="h-12 justify-start gap-3 text-base"
              onClick={() => {
                share()
                setActionsOpen(false)
              }}
            >
              <Share />
              Share
            </Button>
            <Button
              variant="ghost"
              size="lg"
              className="h-12 justify-start gap-3 text-base text-destructive hover:text-destructive"
              onClick={() => {
                setActionsOpen(false)
                setConfirmingDelete(true)
              }}
            >
              <Trash2 />
              Delete
            </Button>
          </div>
        </DrawerContent>
      </Drawer>

      <NoteDeleteDialog
        path={path}
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        onDeleted={onDeleted}
      />
    </>
  )
}
