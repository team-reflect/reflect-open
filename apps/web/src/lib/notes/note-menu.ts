import type { ContextMenuAction, ContextMenuSeparator } from '@reflect/app'
import { canTrashNote } from '@reflect/core'

export type NoteMenuId =
  | 'open'
  | 'open-in-new-window'
  | 'pin'
  | 'unpin'
  | 'toggle-private'
  | 'copy-deep-link'
  | 'copy-path'
  | 'reveal'
  | 'trash'

export type NoteMenuSurface = 'allNotes' | 'sidebar'

export interface NoteMenuTarget {
  readonly path: string
  readonly isPinned: boolean
}

type NoteMenuAction = ContextMenuAction & { id: NoteMenuId }

type NoteMenuItem = NoteMenuAction | ContextMenuSeparator

interface NoteMenuOptions {
  surface: NoteMenuSurface
  isPrivate?: boolean | undefined
}

function action(id: NoteMenuId, title: string): NoteMenuAction {
  return { type: 'action', id, title }
}

export function getNoteMenuItems(
  notes: readonly NoteMenuTarget[],
  options: NoteMenuOptions,
): NoteMenuItem[] {
  const allNotes = options.surface === 'allNotes'
  const single = notes.length === 1
  const { isPrivate } = options
  const groups = [
    [
      allNotes && single && action('open', 'Open'),
      single && action('open-in-new-window', 'Open in New Window'),
    ],
    [
      notes.some((note) => !note.isPinned)
        ? action('pin', single ? 'Pin Note' : 'Pin Notes')
        : action('unpin', single ? 'Unpin Note' : 'Unpin Notes'),
      single &&
        isPrivate !== undefined &&
        action('toggle-private', isPrivate ? 'Unlock Note' : 'Lock Note'),
    ],
    [
      single && action('copy-deep-link', 'Copy Link'),
      single && action('copy-path', 'Copy File Path'),
      single && action('reveal', 'Reveal in Finder'),
    ],
    [allNotes && notes.some((note) => canTrashNote(note.path)) && action('trash', 'Move to Trash')],
  ]
  return groups
    .map((group) => group.filter((item): item is NoteMenuAction => item !== false))
    .filter((group) => group.length > 0)
    .flatMap((group, index) => (index === 0 ? group : [{ type: 'separator' } as const, ...group]))
}
