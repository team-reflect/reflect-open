import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { hasBridge, isDaily, listNotes, listNoteTags } from '@reflect/core'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation'
import { allNotesQueryKey, allNotesTagsQueryKey } from '@/lib/notes/all-notes-query'
import type { NewWindowClickEvent } from '@/lib/windows/open-in-new-window'
import { useListSelection } from '@/lib/selection/use-list-selection'
import { useScrollRestoration } from '@/lib/use-scroll-restoration'
import { useScrollToIndexBridge } from '@/lib/use-scroll-to-index-bridge'
import { useGraph } from '@/providers/graph-provider'
import { routeForPath } from '@/routing/route'
import { useRouter } from '@/routing/router'
import { AllNotesFilters } from './all-notes-filters'
import { AllNotesTable } from './all-notes-table'
import { AllNotesTrashDialog } from './all-notes-trash-dialog'
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
 * deliberately absent from the unfiltered view, but appear when they match the
 * active tag.
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
  const navigateNoteLink = useNoteLinkNavigation()
  // The scroll container lives in state, not a ref, so scroll restoration
  // re-runs its restore once the element attaches (a callback ref re-renders;
  // a plain ref would still be null during the restore effect on the first,
  // warm-cache-only mount). The table virtualizes against this container as its
  // parent, so it no longer needs the element handed down.
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
  const openNote = useCallback(
    (path: string, event?: NewWindowClickEvent) =>
      navigateNoteLink(routeForPath(path), event),
    [navigateNoteLink],
  )
  const handleFilterSelect = useCallback(
    (next: string | null) => navigate({ kind: 'allNotes', tag: next }),
    [navigate],
  )

  // The bulk-trash confirm: the screen owns whether it's open and which paths it
  // acts on (snapshotted at open time, since the delete prunes the live
  // selection); the dialog owns the delete and its error. Daily rows remain
  // selectable for keyboard navigation, but are never valid trash targets.
  const [confirmingTrash, setConfirmingTrash] = useState(false)
  const [pendingPaths, setPendingPaths] = useState<readonly string[]>([])
  const trashableSelectedPaths = useMemo(
    () => [...selection.selected].filter((path) => !isDaily(path)),
    [selection.selected],
  )
  const openTrashConfirm = useCallback(() => {
    if (trashableSelectedPaths.length === 0) {
      return
    }
    setPendingPaths(trashableSelectedPaths)
    setConfirmingTrash(true)
  }, [trashableSelectedPaths])

  // The table owns the virtualizer; the bridge lets the keyboard nav pull an
  // off-screen (unmounted) row into view through the virtualizer's scrollToIndex.
  const { scrollToIndex, registerScrollToIndex } = useScrollToIndexBridge()

  useAllNotesKeyboard({
    selection,
    orderedPaths,
    onOpen: openNote,
    onRequestTrash: openTrashConfirm,
    rootRef,
    scrollToIndex,
  })

  // Move focus into the surface on mount so the shortcuts work the moment you
  // navigate here, without first clicking the list (mirrors the Tasks view).
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      aria-label="All notes"
      className="flex h-full min-h-0 flex-col outline-none"
    >
      <header className="flex flex-none flex-wrap items-center justify-between gap-3 border-b border-border py-4 pl-12 pr-7">
        <h1 className="text-[15px] font-semibold text-text">Notes</h1>
        <div className="flex flex-wrap items-center gap-3">
          {trashableSelectedPaths.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              aria-label={`Trash (${trashableSelectedPaths.length})`}
              onClick={openTrashConfirm}
              className="text-text-secondary hover:text-destructive"
            >
              <Trash2 aria-hidden className="size-3.5" />
              <span>Trash</span>
              <span
                aria-hidden
                className="flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive/10 px-1 text-[10px] font-semibold leading-none tabular-nums text-destructive"
              >
                {trashableSelectedPaths.length}
              </span>
            </Button>
          ) : null}
          <AllNotesFilters
            tag={tag}
            facets={facets ?? []}
            onSelect={handleFilterSelect}
          />
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
          onOpen={openNote}
          registerScrollToIndex={registerScrollToIndex}
        />
      </div>

      <AllNotesTrashDialog
        open={confirmingTrash}
        onOpenChange={setConfirmingTrash}
        paths={pendingPaths}
        onTrashed={selection.clear}
      />
    </div>
  )
}
