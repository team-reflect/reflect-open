import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { errorMessage, hasBridge, listNotes, listNoteTags } from '@reflect/core'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import { allNotesQueryKey, allNotesTagsQueryKey } from '@/lib/notes/all-notes-query'
import { useNoteTrash } from '@/lib/notes/use-note-trash'
import { useListSelection } from '@/lib/selection/use-list-selection'
import { useScrollRestoration } from '@/lib/use-scroll-restoration'
import { useGraph } from '@/providers/graph-provider'
import { routeForPath } from '@/routing/route'
import { useRouter } from '@/routing/router'
import { AllNotesFilters } from './all-notes-filters'
import { AllNotesTable } from './all-notes-table'
import { NewNoteButton } from './new-note-button'
import { useAllNotesKeyboard } from './use-all-notes-keyboard'

interface AllNotesScreenProps {
  /** Active tag filter carried by the route (`null` = all non-daily notes). */
  tag: string | null
}

/**
 * The All Notes screen (a routed view, like settings): every non-daily note,
 * newest first, filterable by tag. The active tag lives on the route so
 * back/forward and "open a note, come back" keep the filter. Daily notes are
 * deliberately absent — the stream is their home.
 *
 * Rows are multi-selectable (V1 parity): click to select (⌘ toggle, Shift
 * range), the indicator gutter toggles, the subject or a double-click opens.
 * Keyboard shortcuts act on the selection — ↑/↓ (Shift to extend), ⌘A select
 * all, Return open, ⌘⌫ trash (to the OS trash, after a confirm), Esc clear.
 *
 * Owns its scroll container (the daily stream's shape, not `ScrollRestored`'s)
 * so the header and filter bar stay put while the virtualized table scrolls,
 * wired to the router's per-entry scroll memory by hand.
 */
export function AllNotesScreen({ tag }: AllNotesScreenProps): ReactElement {
  const { graph } = useGraph()
  const { navigate } = useRouter()
  // The scroll container lives in state, not a ref: the virtualizer down in
  // AllNotesTable reads it via getScrollElement, and a plain ref would be null
  // during the table's mount-time layout effect (refs on ancestor DOM nodes
  // attach after a child component's effects). With a warm query cache that
  // mount is the only render, so the virtualizer would never acquire the
  // element and the list would stay blank. State forces the post-attach
  // re-render that hands the element over.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  // The surface, so the keyboard shortcuts can scope to it (and focus it on mount).
  const rootRef = useRef<HTMLDivElement>(null)
  const enabled = hasBridge() && graph !== null

  const { data: notes } = useQuery({
    queryKey: allNotesQueryKey(graph?.root, tag),
    queryFn: () => listNotes({ tag }),
    enabled,
  })
  const { data: facets } = useQuery({
    queryKey: allNotesTagsQueryKey(graph?.root),
    queryFn: () => listNoteTags(),
    enabled,
  })

  const ready = notes !== undefined
  const { onScroll } = useScrollRestoration(scrollElement, ready)

  // The flat, render-order paths the selection and its shortcuts act on.
  const orderedPaths = useMemo(() => (notes ?? []).map((note) => note.path), [notes])
  const selection = useListSelection(orderedPaths)
  const { trash, isTrashing } = useNoteTrash()
  const [confirmingTrash, setConfirmingTrash] = useState(false)
  const [trashError, setTrashError] = useState<string | null>(null)
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  // Close the confirm if the selection it acts on goes away (a reindex pruned
  // the selected rows) — mirrors the Tasks view's schedule-popover guard.
  if (confirmingTrash && selection.selectedCount === 0 && !isTrashing) {
    setConfirmingTrash(false)
  }

  // The table owns the virtualizer; it registers its scroll-to-index here so the
  // keyboard nav can pull an off-screen (unmounted) row into view.
  const scrollToIndexRef = useRef<(index: number) => void>(() => {})
  const registerScrollToIndex = useCallback((scrollToIndex: (index: number) => void) => {
    scrollToIndexRef.current = scrollToIndex
  }, [])
  const scrollToIndex = useCallback((index: number) => scrollToIndexRef.current(index), [])

  useAllNotesKeyboard({
    selection,
    orderedPaths,
    onOpen: (path) => navigate(routeForPath(path)),
    onRequestTrash: () => setConfirmingTrash(true),
    rootRef,
    scrollToIndex,
  })

  // Move focus into the surface on mount so the shortcuts work the moment you
  // navigate here, without first clicking the list (mirrors the Tasks view).
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  const onConfirmTrash = async (): Promise<void> => {
    setTrashError(null)
    try {
      await trash([...selection.selected])
      selection.clear()
      setConfirmingTrash(false)
    } catch (cause) {
      setTrashError(errorMessage(cause))
    }
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      aria-label="All notes"
      className="flex h-full min-h-0 flex-col outline-none"
    >
      <header className="flex flex-none flex-wrap items-center justify-between gap-3 border-b border-border py-4 pl-4 pr-7 lg:pl-12">
        <h1 className="text-[15px] font-semibold text-text">Notes</h1>
        <div className="flex flex-wrap items-center gap-3">
          <AllNotesFilters
            tag={tag}
            facets={facets ?? []}
            onSelect={(next) => navigate({ kind: 'allNotes', tag: next })}
          />
          {selection.selectedCount > 0 ? (
            <button
              type="button"
              onClick={() => setConfirmingTrash(true)}
              className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text-secondary shadow-sm transition-colors duration-100 hover:bg-surface-hover hover:text-destructive"
            >
              <Trash2 aria-hidden className="size-4" />
              Trash ({selection.selectedCount})
            </button>
          ) : null}
          <NewNoteButton />
        </div>
      </header>
      <div
        ref={setScrollElement}
        data-testid="all-notes-scroll"
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto"
      >
        <AllNotesTable
          notes={notes}
          tag={tag}
          selection={selection}
          onOpen={(path) => navigate(routeForPath(path))}
          scrollElement={scrollElement}
          registerScrollToIndex={registerScrollToIndex}
        />
      </div>

      <Dialog
        open={confirmingTrash}
        onOpenChange={(open) => !isTrashing && setConfirmingTrash(open)}
      >
        <DialogContent
          onOpenAutoFocus={(event) => {
            // Focus the confirm action so ⌘⌫ → Return completes from the keyboard.
            event.preventDefault()
            confirmButtonRef.current?.focus()
          }}
        >
          <DialogTitle>
            Trash {selection.selectedCount} {selection.selectedCount === 1 ? 'note' : 'notes'}?
          </DialogTitle>
          <DialogDescription>
            They move to your system Trash, where you can restore them.
          </DialogDescription>
          {trashError !== null ? <p className="text-sm text-destructive">{trashError}</p> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" disabled={isTrashing}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              ref={confirmButtonRef}
              variant="destructive"
              disabled={isTrashing}
              onClick={() => void onConfirmTrash()}
            >
              Trash
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
