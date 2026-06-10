import type { ReactElement, RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { NoteListEntry } from '@reflect/core'
import { cn } from '@/lib/utils'
import { ALL_NOTES_GRID, AllNotesRow } from './all-notes-row'

interface AllNotesTableProps {
  /** `undefined` while the index query settles (renders nothing, not "empty"). */
  notes: NoteListEntry[] | undefined
  /** The active tag filter, for the empty state's wording. */
  tag: string | null
  onOpen: (path: string) => void
  /** The screen's scroll container — the virtualizer windows against it. */
  scrollRef: RefObject<HTMLDivElement | null>
}

const ESTIMATED_ROW_HEIGHT = 46

/**
 * The All Notes table: a sticky header row over virtualized note rows. The
 * list is uncapped — virtualization (the original app used react-virtuoso the
 * same way) keeps a many-thousand-note graph as cheap as a ten-note one, so
 * there is no silent "first N" truncation.
 */
export function AllNotesTable({
  notes,
  tag,
  onOpen,
  scrollRef,
}: AllNotesTableProps): ReactElement | null {
  const rows = notes ?? []
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 10,
  })

  if (notes === undefined) {
    return null
  }
  return (
    <div>
      <div
        className={cn(
          ALL_NOTES_GRID,
          'sticky top-0 z-10 border-b border-border bg-surface px-3 pb-2 text-xs font-medium text-text-muted',
        )}
      >
        <span>Subject</span>
        <span>Snippet</span>
        <span>Tags</span>
        <span className="text-right">Updated</span>
      </div>
      {notes.length === 0 ? (
        <p className="px-3 py-8 text-sm text-text-muted">
          {tag === null ? 'No notes yet.' : `No notes tagged #${tag}.`}
        </p>
      ) : (
        <ul className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const note = rows[item.index]
            return (
              <li
                key={note.path}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute inset-x-0 border-b border-border"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <AllNotesRow note={note} onOpen={onOpen} />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
