import { useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { foldTag, hasBridge, listNotes, listNoteTags } from '@reflect/core'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useScrollRestoration } from '@/lib/use-scroll-restoration'
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
  const { navigate } = useRouter()
  // The scroll container lives in state, not a ref: the virtualizer down in
  // AllNotesTable reads it via getScrollElement, and a plain ref would be null
  // during the table's mount-time layout effect (refs on ancestor DOM nodes
  // attach after a child component's effects). With a warm query cache that
  // mount is the only render, so the virtualizer would never acquire the
  // element and the list would stay blank. State forces the post-attach
  // re-render that hands the element over.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
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

  const ready = notes !== undefined
  const { onScroll } = useScrollRestoration(scrollElement, ready)

  return (
    <div aria-label="All notes" className="flex h-full min-h-0 flex-col">
      <header className="flex flex-none flex-wrap items-center justify-between gap-3 border-b border-border py-4 pl-4 pr-7 lg:pl-12">
        <h1 className="text-[15px] font-semibold text-text">Notes</h1>
        <div className="flex flex-wrap items-center gap-3">
          <AllNotesFilters
            tag={tag}
            facets={facets ?? []}
            onSelect={(next) => navigate({ kind: 'allNotes', tag: next })}
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
          onOpen={(path) => navigate(routeForPath(path))}
          scrollElement={scrollElement}
        />
      </div>
    </div>
  )
}
