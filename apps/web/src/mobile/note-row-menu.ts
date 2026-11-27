import type { ContextMenuItem } from '@reflect/app'
import type { NoteRowModel } from '@/mobile/swipeable-note-row.tsx'

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
