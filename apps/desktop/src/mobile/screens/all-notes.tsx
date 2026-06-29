import { type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Virtualizer } from 'virtua'
import {
  hasBridge,
  listNotes,
  listNoteTags,
  parseHighlights,
  parseSearchQuery,
  searchWithFilters,
  foldTag,
  type FilteredSearchHit,
  type NoteListEntry,
  type ParsedSearchQuery,
} from '@reflect/core'
import { Input } from '@/components/ui/input'
import { formatRecencyLabel } from '@/lib/dates'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { cn } from '@/lib/utils'
import { useGraph } from '@/providers/graph-provider'
import { useSettings } from '@/providers/settings-provider'
import { routeForPath } from '@/routing/route'
import { useRouter } from '@/routing/router'

const SEARCH_LIMIT = 50

/**
 * A typed search constrained by the route's tag badge: the badge stays
 * honest while searching (exported for tests). Tags parsed from `#tokens`
 * in the text dedupe against the route tag by folded key.
 */
export function searchQueryWithTag(query: string, tag: string | null): ParsedSearchQuery {
  const parsed = parseSearchQuery(query)
  if (tag === null) {
    return parsed
  }
  const key = foldTag(tag)
  if (parsed.filters.tags.includes(key)) {
    return parsed
  }
  return {
    ...parsed,
    filtered: true,
    filters: { ...parsed.filters, tags: [...parsed.filters.tags, key] },
  }
}

interface MobileAllNotesProps {
  /** The live search text — lifted to the shell so it survives navigation. */
  query: string
  onQueryChange: (query: string) => void
  /** The active tag filter from the `allNotes` route (`null` = every note). */
  tag: string | null
}

/**
 * The All tab (Plan 19, V1 parity): every non-daily note, newest first, with
 * an embedded search bar and tag filter badges — V1's All Notes shape. A
 * blank query lists notes (`listNotes`); typing switches to ranked FTS
 * (`searchWithFilters`, the same engine as desktop's palette). Rows are
 * virtualized; the scroll element is **state, not a ref**, so a warm-cache
 * single-render mount still hands the element to the virtualizer.
 */
export function MobileAllNotes({ query, onQueryChange, tag }: MobileAllNotesProps): ReactElement {
  const { graph } = useGraph()
  const { navigate } = useRouter()
  const enabled = hasBridge() && graph !== null
  const searching = query.trim() !== ''

  const { data: notes } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'mobile-all-notes', tag === null ? null : foldTag(tag)],
    queryFn: () => listNotes({ tag }),
    enabled: enabled && !searching,
  })
  const { data: facets } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'all-notes-tags'],
    queryFn: () => listNoteTags(),
    enabled,
  })
  const { data: hits } = useQuery({
    queryKey: [
      INDEX_QUERY_SCOPE,
      graph?.root,
      'mobile-search',
      query,
      tag === null ? null : foldTag(tag),
    ],
    queryFn: () => searchWithFilters(searchQueryWithTag(query, tag), SEARCH_LIMIT),
    enabled: enabled && searching,
  })

  return (
    <div
      className="flex h-full w-screen flex-col"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <header className="shrink-0 space-y-2 border-b border-border px-4 pb-2 pt-1">
        <Input
          type="search"
          inputMode="search"
          placeholder="Search notes…"
          aria-label="Search notes"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          className="text-base"
        />
        {facets !== undefined && facets.length > 0 && (
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {facets.map((facet) => {
              const active = tag !== null && foldTag(tag) === foldTag(facet.tag)
              return (
                <button
                  key={facet.tag}
                  type="button"
                  onClick={() => navigate({ kind: 'allNotes', tag: active ? null : facet.tag })}
                  className={cn(
                    'shrink-0 rounded-full border border-border px-2.5 py-0.5 text-xs',
                    active ? 'bg-primary text-primary-foreground' : 'text-text-muted',
                  )}
                >
                  #{facet.tag}
                </button>
              )
            })}
          </div>
        )}
      </header>
      {searching ? (
        <SearchResults hits={hits} onOpen={(path) => navigate(routeForPath(path))} />
      ) : (
        <NoteRows notes={notes} onOpen={(path) => navigate(routeForPath(path))} />
      )}
    </div>
  )
}

/** The virtualized note list (blank query). */
function NoteRows({
  notes,
  onOpen,
}: {
  notes: NoteListEntry[] | undefined
  onOpen: (path: string) => void
}): ReactElement {
  const { settings } = useSettings()
  const rows = notes ?? []

  if (notes !== undefined && notes.length === 0) {
    return <Empty message="No notes yet" />
  }

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto"
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom), var(--keyboard-height, 0px))' }}
    >
      <Virtualizer as="ul" item="li" data={rows} itemSize={64} bufferSize={640}>
        {(note) => (
          <button
            key={note.path}
            type="button"
            onClick={() => onOpen(note.path)}
            className="flex w-full flex-col gap-0.5 border-b border-border px-4 py-2.5 text-left"
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-sm font-medium">{note.title}</span>
              <span className="shrink-0 text-xs text-text-muted">
                {formatRecencyLabel(note.mtime, settings)}
              </span>
            </span>
            {note.snippet !== '' && (
              <span className="line-clamp-2 text-xs text-text-muted">{note.snippet}</span>
            )}
          </button>
        )}
      </Virtualizer>
    </div>
  )
}

/** Ranked FTS results with highlighted snippets. */
function SearchResults({
  hits,
  onOpen,
}: {
  hits: FilteredSearchHit[] | undefined
  onOpen: (path: string) => void
}): ReactElement {
  if (hits !== undefined && hits.length === 0) {
    return <Empty message="No matches" />
  }

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto"
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom), var(--keyboard-height, 0px))' }}
    >
      <ul>
        {(hits ?? []).map((hit) => (
          <li key={hit.path}>
            <button
              type="button"
              onClick={() => onOpen(hit.path)}
              className="flex w-full flex-col gap-0.5 border-b border-border px-4 py-2.5 text-left"
            >
              <span className="truncate text-sm font-medium">{hit.title}</span>
              {hit.snippet !== null && (
                <span className="line-clamp-2 text-xs text-text-muted">
                  {parseHighlights(hit.snippet).map((segment, index) =>
                    segment.highlighted ? (
                      <mark key={index} className="rounded-sm bg-primary/15 text-text">
                        {segment.text}
                      </mark>
                    ) : (
                      <span key={index}>{segment.text}</span>
                    ),
                  )}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Empty({ message }: { message: string }): ReactElement {
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-text-muted">{message}</div>
  )
}
