import type { ContextMenuItem } from '@reflect/app'
import type { NoteRowModel } from '@/mobile/swipeable-note-row.tsx'

/**
 * The context menu of a note row: Pin or Unpin, Lock note or Unlock note
 * while the privacy is known, and Delete for a note that can go to the
 * trash.
 */
export function getNoteRowMenuItems(
  row: Pick<NoteRowModel, 'isPinned' | 'canDelete'>,
  isPrivate: boolean | undefined,
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    { type: 'action', id: 'pin', title: row.isPinned ? 'Unpin' : 'Pin' },
  ]
  if (isPrivate !== undefined) {
    items.push({ type: 'action', id: 'privacy', title: isPrivate ? 'Unlock note' : 'Lock note' })
  }
  if (row.canDelete) {
    items.push(
      { type: 'separator' },
      { type: 'action', id: 'delete', title: 'Delete', destructive: true },
    )
  }
  return items
}
