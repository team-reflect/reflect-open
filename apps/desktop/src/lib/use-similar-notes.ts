import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { hasBridge, relatedNotes, type RetrievalHit } from '@reflect/core'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'

/**
 * The note's semantic neighbors ("Similar notes"), one query shared by every
 * surface that shows them (the in-note panel and the context sidebars). The
 * key shape is the contract with the index invalidation hook, so it is built
 * here exactly once; the graph root is part of the key for the same reason
 * as {@link useBacklinks} — cached rows must never outlive a graph switch.
 */
export function useSimilarNotes(path: string): UseQueryResult<RetrievalHit[]> {
  const { graph } = useGraph()
  return useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'related', path],
    queryFn: () => relatedNotes(path),
    enabled: hasBridge() && graph !== null,
  })
}
