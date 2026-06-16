import type { MouseEvent, ReactElement } from 'react'
import { Circle, CircleCheck } from 'lucide-react'
import type { NoteListEntry } from '@reflect/core'
import { formatRecencyLabel } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { useSettings } from '@/providers/settings-provider'

/**
 * The shared column template (Indicator · Subject · Snippet · Tags · Updated) —
 * the header row in {@link AllNotesTable} uses the same classes so the columns
 * line up. The leading column is the selection-indicator gutter.
 */
export const ALL_NOTES_GRID =
  'grid grid-cols-[1.25rem_15rem_minmax(0,1fr)_minmax(0,8rem)_5rem] items-center gap-4 pl-4 pr-7 lg:pl-12'

interface AllNotesRowProps {
  note: NoteListEntry
  /** Whether this row is part of the current multi-selection. */
  selected: boolean
  /** Body click: select, honoring ⌘/Ctrl (toggle) and Shift (range) modifiers. */
  onSelect: (event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => void
  /** Indicator click: toggle this row (Shift extends a range) — V1's check gutter. */
  onToggle: (event: Pick<MouseEvent, 'shiftKey'>) => void
  /** Open the note (subject click / double-click). */
  onOpen: (path: string) => void
}

/**
 * One note in the All Notes table. Clicking the row body **selects** it (V1's
 * multi-select: plain = exclusive, ⌘/Ctrl = toggle, Shift = range); the
 * indicator gutter toggles it; the subject or a double-click opens the note.
 */
export function AllNotesRow({ note, selected, onSelect, onToggle, onOpen }: AllNotesRowProps): ReactElement {
  const { settings } = useSettings()
  return (
    <div
      onClick={(event) => {
        // Shift-click selects a range; stop the browser turning that into a text
        // selection across the rows.
        if (event.shiftKey) {
          event.preventDefault()
        }
        onSelect(event)
      }}
      onDoubleClick={() => onOpen(note.path)}
      className={cn(
        'group/row h-12 cursor-default select-none transition-colors duration-100',
        ALL_NOTES_GRID,
        selected ? 'bg-surface-hover ring-1 ring-inset ring-accent' : 'hover:bg-surface-hover',
      )}
    >
      <button
        type="button"
        aria-label={selected ? 'Deselect note' : 'Select note'}
        aria-pressed={selected}
        onClick={(event) => {
          event.stopPropagation()
          onToggle(event)
        }}
        className={cn(
          'flex size-[18px] items-center justify-center text-text-muted transition-opacity duration-100 hover:text-text focus-visible:opacity-100 focus-visible:outline-none',
          selected ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100',
        )}
      >
        {selected ? (
          <CircleCheck aria-hidden className="size-[18px] text-accent" strokeWidth={2} />
        ) : (
          <Circle aria-hidden className="size-[18px]" strokeWidth={2} />
        )}
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onOpen(note.path)
        }}
        className="truncate text-left text-[13px] font-medium text-text focus-visible:outline-none"
      >
        {note.title}
      </button>
      <span className="truncate text-[13px] text-text-secondary">{note.snippet}</span>
      <span className="truncate text-right text-[13px] text-text-secondary">
        {note.tags.map((tag) => `#${tag}`).join(' ')}
      </span>
      <span className="text-right text-[13px] tabular-nums text-text-secondary">
        {note.mtime > 0 ? formatRecencyLabel(note.mtime, settings) : '—'}
      </span>
    </div>
  )
}
