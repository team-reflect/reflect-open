import { useEffect, useRef, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { foldTag, hasBridge, listNotes, listNoteTags } from '@reflect/core'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'
import { routeForPath } from '@/routing/route'
import { useRouter } from '@/routing/router'
import { AllNotesFilters } from './all-notes-filters'
import { AllNotesTable } from './all-notes-table'
import { NewNoteButton } from './new-note-button'

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
 * Owns its scroll container (the daily stream's shape, not `ScrollRestored`'s)
 * so the header and filter bar stay put while the virtualized table scrolls,
 * wired to the router's per-entry scroll memory by hand.
 */
export function AllNotesScreen({ tag }: AllNotesScreenProps): ReactElement {
  const { graph } = useGraph()
  const { arrivalSeq, entryId, navigate, saveScrollState, savedScroll } = useRouter()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const enabled = hasBridge() && graph !== null

  const { data: notes } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'all-notes', tag === null ? null : foldTag(tag)],
    queryFn: () => listNotes({ tag }),
    enabled,
  })
  const { data: facets } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'all-notes-tags'],
    queryFn: () => listNoteTags(),
    enabled,
  })

  // Per-entry scroll memory (ScrollRestored's contract): restore on
  // back/forward, reset to the top for a fresh entry. `arrivalSeq` covers
  // re-arrival on the same entry (sidebar/palette while already here) — the
  // router clears the saved offset for that case, so the list re-anchors to
  // the top like the daily stream does. Gated on the rows being loaded —
  // restoring against an empty (zero-height) list would clamp the offset to 0
  // and lose the position.
  const ready = notes !== undefined
  useEffect(() => {
    if (ready && scrollRef.current) {
      scrollRef.current.scrollTop = savedScroll() ?? 0
    }
  }, [arrivalSeq, entryId, ready, savedScroll])

  return (
    <div aria-label="All notes" className="flex h-full min-h-0 flex-col">
      <header className="px-6 pb-4 pt-8">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-semibold text-text">Notes</h1>
          <div className="flex flex-wrap items-center gap-3">
            <AllNotesFilters
              tag={tag}
              facets={facets ?? []}
              onSelect={(next) => navigate({ kind: 'allNotes', tag: next })}
            />
            <NewNoteButton />
          </div>
        </div>
      </header>
      <div
        ref={scrollRef}
        data-testid="all-notes-scroll"
        onScroll={(event) => saveScrollState(event.currentTarget.scrollTop)}
        className="min-h-0 flex-1 overflow-auto px-6 pb-8"
      >
        <div className="mx-auto w-full max-w-5xl">
          <AllNotesTable
            notes={notes}
            tag={tag}
            onOpen={(path) => navigate(routeForPath(path))}
            scrollRef={scrollRef}
          />
        </div>
      </div>
    </div>
  )
}
