import { useDeferredValue, useMemo, useRef, type ReactElement } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronLeft, FileText, SearchX } from 'lucide-react'
import {
  foldTag,
  hasBridge,
  listNoteTags,
  parseHighlights,
  searchWithFilters,
  type FilteredSearchHit,
  type NoteTagFacet,
} from '@reflect/core'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { FilterBar } from '@/mobile/search-filters/filter-bar'
import {
  buildAllNotesSearch,
  pendingTagToken,
  searchPlanFor,
  type AllNotesFilters,
} from '@/mobile/search-filters/filter-state'
import { NoteRowList, type NoteRowModel } from '@/mobile/note-row-list'
import { SearchInput } from '@/mobile/search-input'
import { useArrivalFocus } from '@/mobile/use-arrival-focus'
import { useGraph } from '@/providers/graph-provider'
import { routeForPath } from '@/routing/route'
import { useRouter } from '@/routing/router'

/** A search hit resolved into the shared row shape. */
export function rowForHit(hit: FilteredSearchHit): NoteRowModel {
  return {
    path: hit.path,
    title: hit.title,
    mtime: hit.mtime,
    isPinned: hit.isPinned,
    snippet:
      hit.snippet !== null
        ? parseHighlights(hit.snippet)
        : hit.preview === ''
          ? []
          : [{ text: hit.preview, highlighted: false }],
  }
}

/** The tags matching a half-typed `#…` token, by folded-substring match. */
export function matchingTagFacets(facets: NoteTagFacet[], partial: string): NoteTagFacet[] {
  const needle = foldTag(partial)
  return facets.filter((facet) => foldTag(facet.tag).includes(needle))
}

interface MobileAllNotesProps {
  /** The live search text — lifted to the shell so it survives navigation. */
  query: string
  onQueryChange: (query: string) => void
  /** The active tag filter from the `allNotes` route (`null` = every note). */
  tag: string | null
  /** The badge filters — lifted to the shell so they survive navigation. */
  filters: AllNotesFilters
  onFiltersChange: (filters: AllNotesFilters) => void
}

/**
 * The All tab (Plan 19, V1 parity): a virtualized fixed-row note list with an
 * embedded search bar and AND-composed filter badges. Everything is one
 * search path ({@link buildAllNotesSearch} → `searchWithFilters`, run per
 * {@link searchPlanFor}): the plain list is the empty query's recall feed
 * (notes only, pinned first, uncapped), badges and typed tokens narrow it,
 * and free text switches to ranked FTS. A trailing `#…` token switches the bar into
 * tag matching (V1): suggestions replace the badge row until the tag is
 * picked or the token completed. The route's tag (a tag tap landed here)
 * rides along as a badge with a back affordance.
 */
export function MobileAllNotes({
  query,
  onQueryChange,
  tag,
  filters,
  onFiltersChange,
}: MobileAllNotesProps): ReactElement {
  const { graph } = useGraph()
  const { navigate, back, arrivalSeq, arrivalFocusEditor } = useRouter()
  const enabled = hasBridge() && graph !== null

  // The All-tab double-tap (`focusEditor` arrivals) lands in the search bar,
  // the tab's capture surface — the daily double-tap's All-flavored twin.
  const searchInputRef = useRef<HTMLInputElement>(null)
  useArrivalFocus({ arrivalSeq, arrivalFocusEditor, target: searchInputRef })

  // Defer the query the index sees (desktop's search debounce): fast typing
  // coalesces while the input stays live, and a seeded query (a `search`
  // history entry) catches up within a frame instead of a fixed delay.
  const deferredQuery = useDeferredValue(query)
  const pending = pendingTagToken(query)
  const parsed = useMemo(
    () => buildAllNotesSearch(deferredQuery, filters, tag),
    [deferredQuery, filters, tag],
  )

  const { data: facets } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'all-notes-tags'],
    queryFn: () => listNoteTags(),
    enabled,
  })
  const { data: hits } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'mobile-all-notes', parsed],
    queryFn: () => searchWithFilters(parsed, searchPlanFor(parsed)),
    enabled,
    // Typing re-keys the query as the deferred value settles; holding the
    // previous rows avoids a blank flash between keystrokes.
    placeholderData: keepPreviousData,
  })

  const rows = useMemo(() => (hits ?? []).map(rowForHit), [hits])
  const pristine = parsed.text === '' && !parsed.filtered

  const addPendingTag = (facet: NoteTagFacet): void => {
    const key = foldTag(facet.tag)
    if (!filters.tags.includes(key)) {
      onFiltersChange({ ...filters, tags: [...filters.tags, key] })
    }
    onQueryChange(pending?.rest ?? '')
  }

  return (
    <div
      className="flex h-full w-screen flex-col"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <header className="shrink-0 space-y-2 border-b border-border px-4 pb-2 pt-1">
        <div className="flex items-center gap-1">
          {tag !== null && (
            <Button
              variant="ghost"
              size="icon"
              className="-ml-2 size-9 shrink-0"
              aria-label="Back"
              onClick={back}
            >
              <ChevronLeft />
            </Button>
          )}
          <SearchInput
            ref={searchInputRef}
            placeholder="Search anything…"
            aria-label="Search notes"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
        {pending !== null ? (
          <TagSuggestions
            facets={matchingTagFacets(facets ?? [], pending.partial)}
            onPick={addPendingTag}
          />
        ) : (
          <FilterBar
            filters={filters}
            onFiltersChange={onFiltersChange}
            facets={facets ?? []}
            routeTag={tag}
            onClearRouteTag={() => navigate({ kind: 'allNotes', tag: null })}
          />
        )}
      </header>
      {/* Undefined hits mean "still fetching" only while the query can run —
          with no bridge/graph it never will, and the empty state is honest. */}
      {enabled && hits === undefined ? (
        <div className="flex flex-1 items-center justify-center" aria-label="Loading notes">
          <Spinner className="size-5 text-text-muted" />
        </div>
      ) : (hits ?? []).length === 0 ? (
        pristine ? (
          <Empty icon={<FileText className="size-6" />} message="No notes yet" />
        ) : (
          <Empty icon={<SearchX className="size-6" />} message="No matches" />
        )
      ) : (
        <NoteRowList rows={rows} onOpen={(path) => navigate(routeForPath(path))} />
      )}
    </div>
  )
}

/** The `#…` tag-matching mode's suggestion row (replaces the badge row). */
function TagSuggestions({
  facets,
  onPick,
}: {
  facets: NoteTagFacet[]
  onPick: (facet: NoteTagFacet) => void
}): ReactElement {
  if (facets.length === 0) {
    return <p className="pb-1 text-xs text-text-muted">No matching tags</p>
  }
  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1" role="listbox" aria-label="Matching tags">
      {facets.map((facet) => (
        <button
          key={facet.tag}
          type="button"
          role="option"
          aria-selected={false}
          onClick={() => onPick(facet)}
          className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-border px-3 text-xs font-medium text-text-muted"
        >
          #{facet.tag}
          <span className="opacity-60">{facet.count}</span>
        </button>
      ))}
    </div>
  )
}

function Empty({ icon, message }: { icon: ReactElement; message: string }): ReactElement {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-text-muted">
      {icon}
      <p className="text-sm">{message}</p>
    </div>
  )
}
