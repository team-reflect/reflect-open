import { useQuery } from '@tanstack/react-query'
import { hasBridge, relatedNotes, type RetrievalHit } from '@reflect/core'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'
import { useSettings } from '@/providers/settings-provider'

/**
 * The note's semantic neighbors ("Similar notes"), one query shared by every
 * surface that shows them (the in-note panel and the context sidebars). The
 * key shape is the contract with the index invalidation hook, so it is built
 * here exactly once; the graph root is part of the key for the same reason
 * as {@link useBacklinks} — cached rows must never outlive a graph switch.
 *
 * Gated on `semanticSearchEnabled` so disabling semantic search empties every
 * surface immediately: the query stops fetching, and the cached rows are
 * masked too — a disabled query still reports its last data, and stored
 * vectors would otherwise keep answering for the rest of the session.
 */
export function useSimilarNotes(path: string): RetrievalHit[] {
  const { graph } = useGraph()
  const { settings } = useSettings()
  const { data } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'related', path],
    queryFn: () => relatedNotes(path),
    enabled: hasBridge() && graph !== null && settings.semanticSearchEnabled,
  })
  return settings.semanticSearchEnabled ? (data ?? []) : []
}
