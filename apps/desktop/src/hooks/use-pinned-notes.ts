import { useQuery } from '@tanstack/react-query'
import { getPinnedNotes, hasBridge, type PinnedNote } from '@reflect/core'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'

export function pinnedNotesQueryKey(
  graphRoot: string | undefined,
): readonly [typeof INDEX_QUERY_SCOPE, string | undefined, 'pinned-notes'] {
  return [INDEX_QUERY_SCOPE, graphRoot, 'pinned-notes']
}

/**
 * The pinned notes from the index, kept fresh by the usual index invalidation
 * (a pin lands in the file, the watcher re-indexes it, the query refetches).
 * Shared by the sidebar's Pinned section and the Recents dedup — one query
 * key, so both consumers ride a single fetch.
 */
export function usePinnedNotes(): PinnedNote[] {
  const { graph } = useGraph()
  const { data } = useQuery({
    queryKey: pinnedNotesQueryKey(graph?.root),
    queryFn: () => getPinnedNotes(),
    enabled: hasBridge() && graph !== null,
  })
  return data ?? []
}
