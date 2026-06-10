import type { ReactElement } from 'react'
import type { NoteListEntry } from '@reflect/core'
import { formatRecencyLabel } from '@/lib/dates'
import { cn } from '@/lib/utils'

/**
 * The shared column template (Subject · Snippet · Tags · Updated) — the header
 * row in {@link AllNotesTable} uses the same classes so the columns line up.
 */
export const ALL_NOTES_GRID =
  'grid grid-cols-[minmax(0,1.3fr)_minmax(0,2fr)_minmax(0,8rem)_5rem] items-center gap-4'

interface AllNotesRowProps {
  note: NoteListEntry
  onOpen: (path: string) => void
}

/** One note in the All Notes table; the whole row opens the note. */
export function AllNotesRow({ note, onOpen }: AllNotesRowProps): ReactElement {
  return (
    <button
      type="button"
      onClick={() => onOpen(note.path)}
      className={cn(
        ALL_NOTES_GRID,
        'w-full px-3 py-3 text-left transition-colors duration-100 hover:bg-surface-hover',
      )}
    >
      <span className="truncate text-sm font-medium text-text">{note.title}</span>
      <span className="truncate text-[13px] text-text-muted">{note.snippet}</span>
      <span className="truncate text-[13px] text-text-muted">
        {note.tags.map((tag) => `#${tag}`).join(' ')}
      </span>
      <span className="text-right text-[13px] tabular-nums text-text-muted">
        {formatRecencyLabel(note.mtime)}
      </span>
    </button>
  )
}
