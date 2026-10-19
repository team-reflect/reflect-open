import { useDeferredValue, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { parseSearchQuery } from '@reflect/core'
import { queryKeys } from '@/lib/query-client.ts'
import { useEmbedStatus } from '@/lib/use-embed-status.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import { useAppServices } from '@/services/services-provider.tsx'
import type { PaletteSections } from './entries.ts'

/**
 * The palette's data layer (Plan 08), extracted so the component stays
 * presentational: query deferral, filter parsing, the caching of the two
 * index reads of `PaletteSearchService` (title suggestions + the one search
 * path, whose filters may be empty), and the settled/failed accounting the
 * empty-state needs.
 */

export interface PaletteResults {
  sections: PaletteSections
  /** True once the index has answered the *live* query (gates "No results"). */
  resultsSettled: boolean
  /** True when an index read errored — "No results" would be a lie. */
  searchFailed: boolean
}

export function usePaletteResults(open: boolean, query: string): PaletteResults {
  const { graph } = useGraph()
  const { paletteSearch } = useAppServices()
  // Hybrid needs both halves of the opt-in: the setting on *and* the model
  // ready. The setting gate makes disabling immediate — the model stays loaded
  // for the session, but its results must not. Plain-text queries blend
  // semantic hits via RRF and degrade invisibly to lexical without either.
  // Filtered queries stay constraint-based — filters are exact by nature.
  const { settings } = useSettings()
  const embed = useEmbedStatus()
  const hybrid = settings.semanticSearchEnabled && embed.status === 'ready'

  // Defer the query the index sees: fast typing coalesces (the plan's
  // debounce) while the input itself stays perfectly responsive.
  const trimmed = useDeferredValue(query.trim())
  // Filter tokens (#tag, is:daily, is:pinned, links:, linked-from:, updated:)
  // switch the search into constrained mode (Plan 08b); plain text is the same
  // query with empty filters — one search path.
  const parsed = useMemo(() => parseSearchQuery(trimmed), [trimmed])
  const searching = open && graph !== null && !trimmed.startsWith('>')
  // The generated date suggestions are relative to today, so the calendar day is
  // part of the cache identity — without it a palette cached before midnight
  // would serve a stale "Tomorrow" afterwards. Computed once so the key and the
  // query agree on the same day.
  const today = paletteSearch.today()

  const {
    data: suggestions,
    isLoading: suggestionsLoading,
    isError: suggestionsError,
  } = useQuery({
    queryKey: queryKeys.index.paletteSuggestions(graph?.root, {
      text: trimmed,
      dateFormat: settings.dateFormat,
      weekStartDay: settings.weekStartDay,
      today,
    }),
    queryFn: () => {
      return paletteSearch.suggestTitles(trimmed, {
        today,
        dateFormat: settings.dateFormat,
        weekStartDay: settings.weekStartDay,
      })
    },
    enabled: searching && !parsed.filtered,
  })
  const useHybrid = hybrid && !parsed.filtered
  const {
    data: hits,
    isLoading: hitsLoading,
    isError: hitsError,
  } = useQuery({
    queryKey: queryKeys.index.paletteSearch(graph?.root, useHybrid ? 'hybrid' : 'lexical', trimmed),
    queryFn: () => paletteSearch.search(trimmed, { hybrid: useHybrid }),
    enabled: searching && trimmed !== '',
  })

  // "No results" must mean the index answered **the live query**: the active
  // fetches settled (isLoading, not isPending — a disabled query is forever
  // pending) *and* the deferred value has caught up. Opening pre-filled, the
  // deferred value can settle on the stale previous query first; that state
  // is "still answering", not "empty".
  const resultsSettled = !suggestionsLoading && !hitsLoading && trimmed === query.trim()
  // An errored query is "settled" to TanStack but not an answer.
  const searchFailed = suggestionsError || hitsError

  const sections = useMemo(() => {
    return paletteSearch.sections({
      query,
      dataQuery: trimmed,
      suggestions: suggestions ?? [],
      hits: hits ?? [],
      filtered: parsed.filtered,
    })
  }, [paletteSearch, query, trimmed, suggestions, hits, parsed.filtered])

  return { sections, resultsSettled, searchFailed }
}
