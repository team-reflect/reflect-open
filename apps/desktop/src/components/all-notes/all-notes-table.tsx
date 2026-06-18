import { useCallback, useEffect, type MouseEvent, type ReactElement } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { NoteListEntry } from '@reflect/core'
import { type ListSelection } from '@/lib/selection/use-list-selection'
import { cn } from '@/lib/utils'
import { ALL_NOTES_GRID, AllNotesRow } from './all-notes-row'

interface AllNotesTableProps {
  /** `undefined` while the index query settles (renders nothing, not "empty"). */
  notes: NoteListEntry[] | undefined
  /** The active tag filter, for the empty state's wording. */
  tag: string | null
  /** The shared row selection (click/keyboard); rows read their selected state from it. */
  selection: ListSelection
  onOpen: (path: string) => void
  /**
   * The screen's scroll container — the virtualizer windows against it. An
   * element (state in the screen), not a ref: the virtualizer only re-checks
   * its scroll element on render, so it must re-render when the container
   * attaches or a warm-cache mount leaves it permanently unmeasured (blank).
   */
  scrollElement: HTMLDivElement | null
  /**
   * Hand the screen a way to scroll a row index into view — a virtualized
   * off-screen row isn't in the DOM, so the keyboard nav can't `scrollIntoView`
   * it; only the virtualizer's own `scrollToIndex` reaches an unmounted row.
   */
  registerScrollToIndex: (scrollToIndex: (index: number) => void) => void
}

const ESTIMATED_ROW_HEIGHT = 48

/**
 * The All Notes table: a sticky header row over virtualized note rows. The
 * list is uncapped — virtualization (the original app used react-virtuoso the
 * same way) keeps a many-thousand-note graph as cheap as a ten-note one, so
 * there is no silent "first N" truncation.
 */
export function AllNotesTable({
  notes,
  tag,
  selection,
  onOpen,
  scrollElement,
  registerScrollToIndex,
}: AllNotesTableProps): ReactElement | null {
  const rows = notes ?? []
  const handleToggle = useCallback(
    (path: string, event: Pick<MouseEvent, 'shiftKey'>) =>
      selection.clickSelect(
        path,
        event.shiftKey
          ? { metaKey: false, ctrlKey: false, shiftKey: true }
          : { metaKey: true, ctrlKey: false, shiftKey: false },
      ),
    [selection.clickSelect],
  )
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 10,
  })

  useEffect(() => {
    registerScrollToIndex((index) => {
      if (index >= 0) {
        virtualizer.scrollToIndex(index, { align: 'auto' })
      }
    })
  }, [virtualizer, registerScrollToIndex])

  if (notes === undefined) {
    return null
  }
  return (
    <div>
      <div
        className={cn(
          ALL_NOTES_GRID,
          'sticky top-0 z-10 border-b border-border bg-surface py-3 text-[13px] font-medium leading-none text-text-secondary shadow-sm',
        )}
      >
        <span>Subject</span>
        <span>Snippet</span>
        <span className="text-right">Tags</span>
        <span className="text-right">Updated</span>
      </div>
      {notes.length === 0 ? (
        <p className="py-8 pl-12 pr-7 text-sm text-text-muted">
          {tag === null ? 'No notes yet.' : `No notes tagged #${tag}.`}
        </p>
      ) : (
        <ul className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const note = rows[item.index]!
            return (
              <li
                key={note.path}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute inset-x-0"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <AllNotesRow
                  note={note}
                  selected={selection.isSelected(note.path)}
                  onSelect={selection.clickSelect}
                  onToggle={handleToggle}
                  onOpen={onOpen}
                />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
