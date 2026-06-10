import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { getBacklinksWithContext, hasBridge, type BacklinkContext } from '@reflect/core'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'

/**
 * The note's inbound links, one query shared by every surface that shows
 * them (the in-note panel and the context sidebars). The key shape is the
 * contract with the index invalidation hook, so it is built here exactly
 * once. The graph root is part of the key: index rows belong to one graph,
 * and a graph switch must never serve the previous graph's cached rows (the
 * cache outlives the workspace remount; invalidation alone lags the
 * reconcile).
 */
export function useBacklinks(path: string): UseQueryResult<BacklinkContext[]> {
  const { graph } = useGraph()
  return useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'backlinks', path],
    queryFn: () => getBacklinksWithContext(path),
    enabled: hasBridge() && graph !== null,
  })
}
