import { useCallback, useMemo } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import {
  getBacklinksWithContext,
  type BacklinkContext,
  type BacklinkContextPage,
  type BacklinkSourceCursor,
} from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready'
import { groupBacklinksBySource, type BacklinkSource } from '@/lib/group-backlinks'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'

const BACKLINK_SOURCES_PER_PAGE = 10

/** What a backlinks surface needs to render: grouped rows plus the states. */
export interface BacklinkSources {
  /** Inbound references grouped by source note, in the query's title order. */
  groups: BacklinkSource[]
  /** Indexed inbound links before equal block contexts collapse for display. */
  count: number
  /** True while the first load is in flight (`groups` is empty then). */
  isLoading: boolean
  /**
   * True when the index query failed. This is the only backlinks source, so a
   * failure means the index is broken, not that the note is unlinked — render
   * it loudly, never as an empty section.
   */
  isError: boolean
  /** Whether another source-note page is available. */
  hasNextPage: boolean
  /** True while the next source-note page is loading. */
  isFetchingNextPage: boolean
  /** True when loading another page failed; already-loaded groups remain usable. */
  isFetchNextPageError: boolean
  /** Load the next source-note page when one is available and no load is active. */
  loadMore: () => void
}

function groupLoadedBacklinks(pages: readonly BacklinkContextPage[]): BacklinkSource[] {
  const contexts: BacklinkContext[] = []
  const seenContexts = new Set<string>()

  for (const page of pages) {
    for (const context of page.contexts) {
      if (context.snippet !== '') {
        const key = `${context.sourcePath}\u{0}${context.snippet}`
        if (seenContexts.has(key)) {
          continue
        }
        seenContexts.add(key)
      }
      contexts.push(context)
    }
  }

  return groupBacklinksBySource(contexts)
}

/**
 * The incoming-backlinks data layer, shared by the desktop panel and the
 * mobile section: one paginated indexed query per visible note, kept fresh by
 * the index invalidation hook (no polling), flattened and grouped across loaded
 * source-note pages. The graph root is part of the key: index rows belong to
 * one graph, and a graph switch must never serve the previous graph's cached
 * rows (the cache outlives the workspace remount; invalidation alone lags the
 * reconcile).
 *
 * @param path graph-relative path of the note whose inbound links to load.
 */
export function useBacklinkSources(path: string): BacklinkSources {
  const { graph } = useGraph()
  const bridgeReady = useBridgeReady()
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isPending,
    isError: queryIsError,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useInfiniteQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'backlinks', path],
    queryFn: ({ pageParam }) =>
      getBacklinksWithContext(path, {
        cursor: pageParam,
        limit: BACKLINK_SOURCES_PER_PAGE,
      }),
    initialPageParam: null as BacklinkSourceCursor | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: bridgeReady && graph !== null,
  })
  const groups = useMemo(() => groupLoadedBacklinks(data?.pages ?? []), [data])
  const loadMore = useCallback(() => {
    if (!hasNextPage || isFetchingNextPage) {
      return
    }
    void fetchNextPage({ cancelRefetch: false })
  }, [fetchNextPage, hasNextPage, isFetchingNextPage])

  return {
    groups,
    count: data?.pages[0]?.indexedLinkCount ?? 0,
    isLoading: isPending,
    isError: queryIsError && data === undefined,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    loadMore,
  }
}
