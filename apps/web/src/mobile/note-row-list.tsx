import { WritableStore } from '@reflect/core'
import { useRef, useState, type ReactElement } from 'react'
import { Virtualizer } from 'virtua'
import { useScrollRestoration } from '@/lib/use-scroll-restoration.ts'
import { ConfirmDrawer } from '@/mobile/confirm-drawer.tsx'
import { NOTE_DELETE_CONFIRM } from '@/mobile/note-actions-menu.tsx'
import {
  NOTE_ROW_HEIGHT,
  SwipeableNoteRow,
  type NoteRowModel,
} from '@/mobile/swipeable-note-row.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

interface NoteRowListProps {
  rows: NoteRowModel[]
  onOpen: (path: string) => void
}

/**
 * The All tab's virtualized note list: fixed-height rows (title, first
 * content line, relative timestamp, a pin marker on pinned notes) shared by
 * the plain list, the filtered feed, and search results — V1's one row shape.
 * Its scroll position is kept per history entry and restored on an All tab
 * return.
 */
export function NoteRowList({ rows, onOpen }: NoteRowListProps): ReactElement {
  const { noteActions } = useCoreServices()
  const [revealedRow] = useState(() => new WritableStore<string | null>(null))
  const [deletePath, setDeletePath] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const { onScroll } = useScrollRestoration(scrollRef, true)

  const togglePin = (row: NoteRowModel): void => {
    void noteActions.togglePinned(row.path)
  }

  return (
    <>
      <div
        // Keyboard avoidance is the shell root's job (it ends at the keyboard's
        // top); `pb-safe` only clears the home indicator when the keyboard is down.
        // `isolate` makes a stacking context, so WebKit composites the row surfaces
        // inside this scroller, below the iOS scroll indicator.
        className="isolate min-h-0 flex-1 overflow-y-auto px-safe pb-safe"
        ref={scrollRef}
        onScroll={(event) => {
          revealedRow.set(null)
          onScroll(event)
        }}
      >
        <Virtualizer as="ul" item="li" data={rows} itemSize={NOTE_ROW_HEIGHT} bufferSize={640}>
          {(row) => (
            <SwipeableNoteRow
              key={row.path}
              row={row}
              revealedRow={revealedRow}
              onOpen={() => onOpen(row.path)}
              onTogglePin={() => togglePin(row)}
              onDelete={() => {
                revealedRow.set(null)
                setDeletePath(row.path)
              }}
            />
          )}
        </Virtualizer>
      </div>
      {deletePath !== null ? (
        <ConfirmDrawer
          key={deletePath}
          confirm={NOTE_DELETE_CONFIRM}
          open
          onOpenChange={(open) => {
            if (!open) {
              setDeletePath(null)
            }
          }}
          onConfirm={() => noteActions.trashOne(deletePath)}
        />
      ) : null}
    </>
  )
}
