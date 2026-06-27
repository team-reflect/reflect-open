import type { QueryClient } from '@tanstack/react-query'
import type { PinnedNote } from '@reflect/core'
import { pinnedNotesQueryKey } from '@/hooks/use-pinned-notes'

/**
 * Apply an optimistic update to the pinned-notes cache. The markdown/index
 * pipeline remains source of truth; this only hides local write latency.
 */
export function updatePinnedNotesCache(
  queryClient: QueryClient,
  graphRoot: string,
  updater: (current: PinnedNote[] | undefined) => PinnedNote[] | undefined,
): void {
  queryClient.setQueryData<PinnedNote[]>(pinnedNotesQueryKey(graphRoot), updater)
}

/** Refetch pinned notes after a failed write so the sidebar reconciles with the index. */
export function invalidatePinnedNotesCache(
  queryClient: QueryClient,
  graphRoot: string,
): void {
  void queryClient.invalidateQueries({ queryKey: pinnedNotesQueryKey(graphRoot) })
}
