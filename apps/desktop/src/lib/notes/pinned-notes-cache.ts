import type { QueryClient } from '@tanstack/react-query'
import type { PinnedNote } from '@reflect/core'
import { queryKeys } from '@/lib/query-client'

/**
 * Apply an optimistic update to the pinned-notes cache. The markdown/index
 * pipeline remains source of truth; this only hides local write latency.
 */
export function updatePinnedNotesCache(
  queryClient: QueryClient,
  graphRoot: string,
  updater: (current: PinnedNote[] | undefined) => PinnedNote[] | undefined,
): void {
  queryClient.setQueryData<PinnedNote[]>(queryKeys.index.pinnedNotes(graphRoot), updater)
}

/** Refetch pinned notes after a failed write so the sidebar reconciles with the index. */
export function invalidatePinnedNotesCache(queryClient: QueryClient, graphRoot: string): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.index.pinnedNotes(graphRoot) })
}
