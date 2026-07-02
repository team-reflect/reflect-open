import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getBacklinksWithContext, hasBridge } from '@reflect/core'
import { groupBacklinksBySource, type BacklinkSource } from '@/lib/group-backlinks'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'

/** What a backlinks surface needs to render: grouped rows plus the states. */
export interface BacklinkSources {
  /** Inbound references grouped by source note, in the query's title order. */
  groups: BacklinkSource[]
  /** Total inbound references (the "(N)" in the section header). */
  count: number
  /** True while the first load is in flight (`groups` is empty then). */
  isLoading: boolean
  /**
   * True when the index query failed. This is the only backlinks source, so a
   * failure means the index is broken, not that the note is unlinked — render
   * it loudly, never as an empty section.
   */
  isError: boolean
}

/**
 * The incoming-backlinks data layer, shared by the desktop panel and the
 * mobile section: one indexed query per visible note, kept fresh by the index
 * invalidation hook (no polling), grouped by source note. The graph root is
 * part of the key: index rows belong to one graph, and a graph switch must
 * never serve the previous graph's cached rows (the cache outlives the
 * workspace remount; invalidation alone lags the reconcile).
 *
 * @param path graph-relative path of the note whose inbound links to load.
 */
export function useBacklinkSources(path: string): BacklinkSources {
  const { graph } = useGraph()
  const { data, isPending, isError } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'backlinks', path],
    queryFn: () => getBacklinksWithContext(path),
    enabled: hasBridge() && graph !== null,
  })
  const groups = useMemo(() => (data ? groupBacklinksBySource(data) : []), [data])
  return { groups, count: data?.length ?? 0, isLoading: isPending, isError }
}
