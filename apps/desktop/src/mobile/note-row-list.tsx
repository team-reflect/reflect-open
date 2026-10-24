import { useState, type ReactElement } from 'react'
import { Virtualizer } from 'virtua'
import { NoteDeleteDrawer } from '@/mobile/note-delete-drawer.tsx'
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
 */
export function NoteRowList({ rows, onOpen }: NoteRowListProps): ReactElement {
  const { noteActions } = useCoreServices()
  const [revealedPath, setRevealedPath] = useState<string | null>(null)
  const [deletePath, setDeletePath] = useState<string | null>(null)

  const togglePin = (row: NoteRowModel): void => {
    void noteActions.togglePinned(row.path)
  }

  return (
    <>
      <div
        // Keyboard avoidance is the shell root's job (it ends at the keyboard's
        // top); `pb-safe` only clears the home indicator when the keyboard is down.
        className="min-h-0 flex-1 overflow-y-auto px-safe pb-safe"
        onScroll={() => setRevealedPath(null)}
      >
        <Virtualizer as="ul" item="li" data={rows} itemSize={NOTE_ROW_HEIGHT} bufferSize={640}>
          {(row) => (
            <SwipeableNoteRow
              key={row.path}
              row={row}
              revealed={revealedPath === row.path}
              onReveal={() => setRevealedPath(row.path)}
              onClose={() => setRevealedPath(null)}
              onBeginInteraction={() => {
                setRevealedPath((current) => (current === row.path ? current : null))
              }}
              onOpen={() => onOpen(row.path)}
              onTogglePin={() => togglePin(row)}
              onDelete={() => {
                setRevealedPath(null)
                setDeletePath(row.path)
              }}
            />
          )}
        </Virtualizer>
      </div>
      {deletePath !== null ? (
        <NoteDeleteDrawer
          key={deletePath}
          path={deletePath}
          open
          onOpenChange={(open) => {
            if (!open) {
              setDeletePath(null)
            }
          }}
        />
      ) : null}
    </>
  )
}
