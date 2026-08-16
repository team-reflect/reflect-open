import { useState, type ReactElement } from 'react'
import { Lock, LockOpen, MoreHorizontal, Pin, PinOff, Share, Trash2 } from 'lucide-react'
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
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer'
import { useNoteRow } from '@/hooks/use-note-row'
import { usePinnedNotes } from '@/hooks/use-pinned-notes'
import { toggleNotePinned } from '@/lib/note-pin'
import { toggleNotePrivate } from '@/lib/note-private'
import { useBridgedNoteToggle } from '@/lib/notes/use-bridged-note-toggle'
import { deleteOpenNote } from '@/lib/note-delete'
import { shareNote } from '@/mobile/share'
import { useGraph } from '@/providers/graph-provider'

interface NoteActionsMenuProps {
  /** Graph-relative path of the note the actions operate on. */
  path: string
  /** Called after the note is deleted, so the screen can navigate away. */
  onDeleted: () => void
}

/**
 * The note screen's "⋯" action sheet (Plan 19): pin/unpin, lock/unlock from
 * external services, share, and delete-to-trash. Pin reflects the index's
 * pinned set; privacy reflects the note's indexed `private: true` flag,
 * bridged by the last toggle result while the mobile write echo and index
 * catch up. {@link shareNote} hands the note's body to the OS share sheet via
 * the Web Share API (`navigator.share`); delete confirms first (it's
 * destructive, even if recoverable from `.reflect/trash/`) and routes through
 * {@link deleteOpenNote} so the open session is discarded rather than flushed.
 */
export function NoteActionsMenu({ path, onDeleted }: NoteActionsMenuProps): ReactElement {
  const { graph } = useGraph()
  const isPinned = usePinnedNotes().some((note) => note.path === path)
  const noteRow = useNoteRow(path)
  const privacyReady = noteRow !== null
  const [actionsOpen, setActionsOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const {
    isActive: isPrivate,
    isToggling: isTogglingPrivate,
    toggleActive: togglePrivate,
  } = useBridgedNoteToggle({
    path,
    indexActive: noteRow?.isPrivate ?? false,
    toggle: toggleNotePrivate,
    failureLabel: (active) => (active ? 'Unlocking note' : 'Locking note'),
  })
  const privacyActionLabel = !privacyReady
    ? 'Loading privacy…'
    : isPrivate
      ? 'Unlock note'
      : 'Lock note'

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
          <div className="flex flex-col gap-1">
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
              disabled={!privacyReady || isTogglingPrivate}
              onClick={() => {
                void togglePrivate()
                setActionsOpen(false)
              }}
            >
              {privacyReady && isPrivate ? <LockOpen aria-hidden /> : <Lock aria-hidden />}
              {privacyActionLabel}
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

      <Dialog open={confirmingDelete} onOpenChange={(open) => !busy && setConfirmingDelete(open)}>
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
            <Button variant="destructive" disabled={busy} onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
