import { useRef, useState, type ReactElement } from 'react'
import { Lock, LockOpen, MoreHorizontal, Pin, PinOff, Share, Trash2 } from 'lucide-react'
import { canTrashNote, errorMessage } from '@reflect/core'
import { Button } from '@/components/ui/button.tsx'
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from '@/mobile/scroll-drawer.tsx'
import { useNoteRowState } from '@/hooks/use-note-row.ts'
import { usePinnedNotes } from '@/hooks/use-pinned-notes.ts'
import { NOTE_DELETE_CONFIRM, NoteDeleteDrawer } from '@/mobile/note-delete-drawer.tsx'
import type { NativeMenuItem } from '@/mobile/native-chrome/protocol.ts'
import { shareNote } from '@/mobile/share.ts'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'
import { useToastController } from '@/lib/use-toasts.ts'

interface NoteActionsMenuProps {
  /** Graph-relative path of the note the actions operate on. */
  path: string
  /** Called after the note is deleted, so the screen can navigate away. */
  onDeleted: () => void
  /** The note's actions, from {@link useNoteActions} with the same `path` and `onDeleted`. */
  actions: NoteActions
}

/**
 * The state of the note actions of one note, and the functions that run them.
 */
export interface NoteActions {
  isPinned: boolean
  isPrivate: boolean
  privacyReady: boolean
  privacyActionLabel: string
  items: NativeMenuItem[]
  pin: () => void
  togglePrivate: () => Promise<void>
  share: () => void
  runAction: (id: string) => void
}

/**
 * The note actions of `path`: their state, their native menu items, and
 * `runAction`, which runs one by id (Delete without asking: callers confirm).
 */
export function useNoteActions(path: string, onDeleted: () => void): NoteActions {
  const { noteActions, logger } = useCoreServices()
  const { share: shareService } = useAppServices()
  const toastController = useToastController()
  const isPinned = usePinnedNotes().some((note) => note.path === path)
  const { row: noteRow, settled: privacyReady } = useNoteRowState(path)
  const isPrivate = noteRow?.isPrivate ?? false
  const privacyActionLabel = !privacyReady
    ? 'Loading privacy…'
    : isPrivate
      ? 'Unlock note'
      : 'Lock note'
  // Set while a delete from the native menu runs, so a second confirm waits.
  const deletingRef = useRef(false)

  const pin = (): void => {
    void noteActions.togglePinned(path)
  }

  const togglePrivate = async (): Promise<void> => {
    await noteActions.togglePrivate(path)
  }

  const share = (): void => {
    void shareNote(shareService, path).catch((cause) => {
      logger.error('share failed:', errorMessage(cause))
    })
  }

  const runAction = (id: string): void => {
    switch (id) {
      case 'pin':
        pin()
        return
      case 'privacy':
        void togglePrivate()
        return
      case 'share':
        share()
        return
      case 'delete':
        if (!canTrashNote(path) || deletingRef.current) {
          return
        }
        deletingRef.current = true
        void noteActions.trashOne(path).then(onDeleted, (cause: unknown) => {
          deletingRef.current = false
          logger.error('delete failed:', errorMessage(cause))
          // The native confirmation has closed, so the error shows as a toast.
          toastController.add({
            type: 'error',
            title: 'Could not delete the note',
            description: errorMessage(cause),
          })
        })
        return
    }
  }

  return {
    isPinned,
    isPrivate,
    privacyReady,
    privacyActionLabel,
    items: noteActionItems({
      isPinned,
      isPrivate,
      privacyReady,
      privacyActionLabel,
      canDelete: canTrashNote(path),
    }),
    pin,
    togglePrivate,
    share,
    runAction,
  }
}

/**
 * The note screen's "⋯" action sheet (Plan 19): pin/unpin, lock/unlock from
 * external services, share, and delete-to-trash. Pin reflects the index's
 * pinned set; privacy reflects the note's indexed `private: true` flag,
 * both with the note-row overlay merged over them while the index catches up. {@link shareNote} hands the note's body to the OS share sheet via
 * the Web Share API (`navigator.share`); delete confirms first (it's
 * destructive, even if recoverable from `.reflect/trash/`) and routes through
 * `NoteActionsService.trashOne` so the open session is discarded rather than flushed.
 */
export function NoteActionsMenu({ path, onDeleted, actions }: NoteActionsMenuProps): ReactElement {
  const { isPinned, isPrivate, privacyReady, privacyActionLabel, pin, togglePrivate, share } =
    actions
  const [actionsOpen, setActionsOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

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
              disabled={!privacyReady}
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

      <NoteDeleteDrawer
        path={path}
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        onDeleted={onDeleted}
      />
    </>
  )
}

/**
 * The note actions as native menu items. Delete, when the note can go to
 * the trash, asks first, with the same words as {@link NoteDeleteDrawer}.
 */
export function noteActionItems({
  isPinned,
  isPrivate,
  privacyReady,
  privacyActionLabel,
  canDelete,
}: {
  isPinned: boolean
  isPrivate: boolean
  privacyReady: boolean
  privacyActionLabel: string
  canDelete: boolean
}): NativeMenuItem[] {
  const items: NativeMenuItem[] = [
    {
      type: 'action',
      id: 'pin',
      title: isPinned ? 'Unpin' : 'Pin',
      icon: isPinned ? 'pin.slash' : 'pin',
    },
    {
      type: 'action',
      id: 'privacy',
      title: privacyActionLabel,
      icon: privacyReady && isPrivate ? 'lock.open' : 'lock',
      disabled: !privacyReady,
    },
    { type: 'action', id: 'share', title: 'Share', icon: 'square.and.arrow.up' },
  ]
  if (!canDelete) {
    return items
  }
  return [
    ...items,
    {
      type: 'section',
      items: [
        {
          type: 'action',
          id: 'delete',
          title: 'Delete',
          icon: 'trash',
          destructive: true,
          confirm: NOTE_DELETE_CONFIRM,
        },
      ],
    },
  ]
}
