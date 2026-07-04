import { useCallback, useEffect, useRef, type MouseEvent, type ReactElement } from 'react'
import { Virtualizer, type VirtualizerHandle } from 'virtua'
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
   * Hand the screen a way to scroll a row index into view — a virtualized
   * off-screen row isn't in the DOM, so the keyboard nav can't `scrollIntoView`
   * it; only the virtualizer's own `scrollToIndex` reaches an unmounted row.
   */
  registerScrollToIndex: (scrollToIndex: (index: number) => void) => void
}

const ESTIMATED_ROW_HEIGHT = 48

/**
 * The All Notes table: a sticky header row over virtualized note rows. The
 * list is uncapped: virtualization keeps a many-thousand-note graph as cheap as
 * a ten-note one, so there is no silent "first N" truncation.
 *
 * Returns a fragment so the list virtualizes against the screen's scroll
 * container (its parent) directly. The header is a leading sibling; `bufferSize`
 * is wide enough to absorb its height so the windowed range never falls short.
 */
export function AllNotesTable({
  notes,
  tag,
  selection,
  onOpen,
  registerScrollToIndex,
}: AllNotesTableProps): ReactElement | null {
  const rows = notes ?? []
  const { clickSelect, isSelected } = selection
  const virtualizerRef = useRef<VirtualizerHandle>(null)
  const handleToggle = useCallback(
    (path: string, event: Pick<MouseEvent, 'shiftKey'>) =>
      clickSelect(
        path,
        event.shiftKey
          ? { metaKey: false, ctrlKey: false, shiftKey: true }
          : { metaKey: true, ctrlKey: false, shiftKey: false },
      ),
    [clickSelect],
  )

  useEffect(() => {
    registerScrollToIndex((index) => {
      if (index >= 0) {
        virtualizerRef.current?.scrollToIndex(index, { align: 'nearest' })
      }
    })
  }, [registerScrollToIndex])

  if (notes === undefined) {
    return null
  }
  return (
    <>
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
        <Virtualizer
          ref={virtualizerRef}
          as="ul"
          item="li"
          data={rows}
          itemSize={ESTIMATED_ROW_HEIGHT}
          bufferSize={10 * ESTIMATED_ROW_HEIGHT}
        >
          {(note) => (
            <AllNotesRow
              key={note.path}
              note={note}
              selected={isSelected(note.path)}
              onSelect={clickSelect}
              onToggle={handleToggle}
              onOpen={onOpen}
            />
          )}
        </Virtualizer>
      )}
    </>
  )
}
