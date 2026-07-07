import { memo, type MouseEvent, type ReactElement } from 'react'
import type { NoteListEntry } from '@reflect/core'
import { formatRecencyLabel } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { useSettings } from '@/providers/settings-provider'

/**
 * The shared column template (Subject · Snippet · Tags · Updated) — the header
 * row in {@link AllNotesTable} uses the same classes so the columns line up.
 * The selection indicator is positioned beside the row, outside the column flow.
 */
export const ALL_NOTES_GRID =
  'grid grid-cols-[minmax(0,15rem)_minmax(0,1fr)_minmax(0,8rem)_6rem] items-center gap-4 pl-12 pr-7'

interface AllNotesRowProps {
  note: NoteListEntry
  /** Whether this row is part of the current multi-selection. */
  selected: boolean
  /** Body click: select, honoring ⌘/Ctrl (toggle) and Shift (range) modifiers. */
  onSelect: (path: string, event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => void
  /** Indicator click: toggle this row (Shift extends a range) — V1's check gutter. */
  onToggle: (path: string, event: Pick<MouseEvent, 'shiftKey'>) => void
  /** Open the note (subject click / double-click). */
  onOpen: (path: string) => void
}

/**
 * One note in the All Notes table. Clicking the row body **selects** it (V1's
 * multi-select: plain = exclusive, ⌘/Ctrl = toggle, Shift = range); the
 * indicator gutter toggles it; the subject or a double-click opens the note.
 */
export const AllNotesRow = memo(function AllNotesRow({ note, selected, onSelect, onToggle, onOpen }: AllNotesRowProps): ReactElement {
  const { settings } = useSettings()
  return (
    <div
      onClick={(event) => {
        // Shift-click selects a range; stop the browser turning that into a text
        // selection across the rows.
        if (event.shiftKey) {
          event.preventDefault()
        }
        onSelect(note.path, event)
      }}
      onDoubleClick={() => onOpen(note.path)}
      className={cn(
        'group/row relative h-12 cursor-default select-none transition-colors duration-100',
        ALL_NOTES_GRID,
        selected
          ? 'border-y border-accent/20 bg-accent-soft text-text dark:border-accent/10 dark:text-text'
          : 'shadow-[var(--border-hairline)] hover:bg-surface-hover',
      )}
    >
      <button
        type="button"
        aria-label={selected ? 'Deselect note' : 'Select note'}
        aria-pressed={selected}
        onClick={(event) => {
          event.stopPropagation()
          onToggle(note.path, event)
        }}
        className={cn(
          'group absolute inset-y-0 left-0 flex w-12 items-center justify-center opacity-0 transition-opacity duration-100 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none',
          selected ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'size-2 rounded-full transition-transform duration-150 group-hover:scale-110',
            selected ? 'bg-accent' : 'ring-1 ring-accent',
          )}
        />
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onOpen(note.path)
        }}
        className={cn(
          'truncate text-left text-[13px] font-medium focus-visible:outline-none',
          selected ? 'text-accent' : 'text-text',
        )}
      >
        {note.title}
      </button>
      <span className={cn('truncate text-[13px]', selected ? 'text-accent' : 'text-text-secondary')}>
        {note.snippet}
      </span>
      <span className="truncate text-right text-[13px] text-text-secondary">
        {note.tags.map((tag) => `#${tag}`).join(' ')}
      </span>
      <span className="whitespace-nowrap text-right text-[13px] tabular-nums text-text-secondary">
        {note.mtime > 0 ? formatRecencyLabel(note.mtime, settings) : '—'}
      </span>
    </div>
  )
})
