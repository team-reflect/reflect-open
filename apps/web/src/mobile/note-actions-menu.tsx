import { useRef } from 'react'
import { canTrashNote, errorMessage } from '@reflect/core'
import type { ChromeMenuItem } from '@/mobile/chrome/screen-chrome.ts'
import { useNoteRowState } from '@/hooks/use-note-row.ts'
import { usePinnedNotes } from '@/hooks/use-pinned-notes.ts'
import { NOTE_DELETE_CONFIRM } from '@/mobile/note-delete-drawer.tsx'
import { shareNote } from '@/mobile/share.ts'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

/**
 * The note actions of one note: the menu items, and the function that runs
 * one by id.
 */
export interface NoteActions {
  items: ChromeMenuItem[]
  runAction: (id: string) => Promise<void>
}

/**
 * The note actions of `path`: pin, lock or unlock, share, and delete to the
 * graph's trash. Pin and privacy read the note row with the overlay merged
 * over the index, so a menu reopened during a write shows the new state.
 * `runAction` runs Delete at once; the Delete item carries its confirmation.
 */
export function useNoteActions(path: string, onDeleted: () => void): NoteActions {
  const { noteActions, logger } = useCoreServices()
  const { share: shareService } = useAppServices()
  const isPinned = usePinnedNotes().some((note) => note.path === path)
  const { row: noteRow, settled: privacyReady } = useNoteRowState(path)
  const isPrivate = noteRow?.isPrivate ?? false
  const privacyActionLabel = !privacyReady
    ? 'Loading privacy…'
    : isPrivate
      ? 'Unlock note'
      : 'Lock note'
  // Set while a delete runs, so a second confirm waits.
  const deletingRef = useRef(false)

  const runAction = async (id: string): Promise<void> => {
    switch (id) {
      case 'pin':
        await noteActions.togglePinned(path)
        return
      case 'privacy':
        await noteActions.togglePrivate(path)
        return
      case 'share':
        try {
          await shareNote(shareService, path)
        } catch (cause) {
          logger.error('share failed:', errorMessage(cause))
        }
        return
      case 'delete':
        if (!canTrashNote(path) || deletingRef.current) {
          return
        }
        deletingRef.current = true
        try {
          await noteActions.trashOne(path)
        } catch (cause) {
          deletingRef.current = false
          logger.error('delete failed:', errorMessage(cause))
          throw new Error('Could not delete the note', { cause })
        }
        onDeleted()
        return
    }
  }

  return {
    items: noteActionItems({
      isPinned,
      isPrivate,
      privacyReady,
      privacyActionLabel,
      canDelete: canTrashNote(path),
    }),
    runAction,
  }
}

/**
 * The note actions as menu items. Delete, when the note can go to the
 * trash, carries `NOTE_DELETE_CONFIRM`.
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
}): ChromeMenuItem[] {
  const items: ChromeMenuItem[] = [
    {
      type: 'action',
      id: 'pin',
      title: isPinned ? 'Unpin' : 'Pin',
      icon: isPinned ? 'pin-off' : 'pin',
    },
    {
      type: 'action',
      id: 'privacy',
      title: privacyActionLabel,
      icon: privacyReady && isPrivate ? 'lock-open' : 'lock',
      disabled: !privacyReady,
    },
    { type: 'action', id: 'share', title: 'Share', icon: 'share' },
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
