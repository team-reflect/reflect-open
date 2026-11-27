import { WritableStore, type IndexQueryService, type NoteRowService } from '@reflect/core'
import { useCallback, useRef, useState, type MouseEvent, type ReactElement } from 'react'
import { Virtualizer } from 'virtua'
import { useScrollRestoration } from '@/lib/use-scroll-restoration.ts'
import { ConfirmDrawer } from '@/mobile/confirm-drawer.tsx'
import { NOTE_DELETE_CONFIRM } from '@/mobile/note-actions-menu.tsx'
import { getNoteRowMenuItems } from '@/mobile/note-row-menu.ts'
import {
  NOTE_ROW_HEIGHT,
  SwipeableNoteRow,
  type NoteRowModel,
} from '@/mobile/swipeable-note-row.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

/**
 * Whether `path` is private, or `undefined` when the index cannot say.
 */
async function readIsPrivate(
  noteRows: NoteRowService,
  indexQuery: IndexQueryService,
  path: string,
): Promise<boolean | undefined> {
  const overlaid = noteRows.get().get(path)?.isPrivate
  if (overlaid !== undefined) {
    return overlaid
  }
  try {
    return (await indexQuery.getNote(path))?.isPrivate ?? false
  } catch {
    return undefined
  }
}

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
  const { noteActions, noteRows, indexQuery } = useCoreServices()
  const { contextMenu } = useAppServices()
  const [revealedRow] = useState(() => new WritableStore<string | null>(null))
  const [deletePath, setDeletePath] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const { onScroll } = useScrollRestoration(scrollRef, true)

  const togglePin = useCallback(
    (row: NoteRowModel): void => {
      void noteActions.togglePinned(row.path)
    },
    [noteActions],
  )
  const requestDelete = useCallback(
    (row: NoteRowModel): void => {
      revealedRow.set(null)
      setDeletePath(row.path)
    },
    [revealedRow],
  )

  const openMenu = useCallback(
    (row: NoteRowModel): void => {
      const items = readIsPrivate(noteRows, indexQuery, row.path).then((isPrivate) => {
        return getNoteRowMenuItems(row, isPrivate)
      })
      void contextMenu.open({
        items,
        onSelect: (id) => {
          if (id === 'pin') {
            togglePin(row)
          } else if (id === 'privacy') {
            void noteActions.togglePrivate(row.path)
          } else if (id === 'delete') {
            requestDelete(row)
          }
        },
      })
    },
    [contextMenu, noteActions, noteRows, indexQuery, togglePin, requestDelete],
  )
  // One listener for the list: virtua renders every mounted row again on each scroll step.
  const onContextMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>): void => {
      const target = event.target instanceof Element ? event.target : null
      const path = target?.closest<HTMLElement>('[data-note-path]')?.dataset.notePath
      const row = rows.find((candidate) => candidate.path === path)
      if (row !== undefined) {
        event.preventDefault()
        openMenu(row)
      }
    },
    [rows, openMenu],
  )

  return (
    <>
      <div
        // Keyboard avoidance is the shell root's job (it ends at the keyboard's
        // top); `pb-safe` only clears the home indicator when the keyboard is down.
        // `isolate` makes a stacking context, so WebKit composites the row surfaces
        // inside this scroller, below the iOS scroll indicator.
        className="isolate min-h-0 flex-1 overflow-y-auto px-safe pb-safe"
        ref={scrollRef}
        onContextMenu={onContextMenu}
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
              onOpen={onOpen}
              onTogglePin={togglePin}
              onDelete={requestDelete}
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
