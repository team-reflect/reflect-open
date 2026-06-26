import type { QueryClient } from '@tanstack/react-query'
import type { PinnedNote } from '@reflect/core'
import { pinnedNotesQueryKey } from '@/hooks/use-pinned-notes'

export interface PinnedNotesCacheSnapshot {
  readonly queryKey: ReturnType<typeof pinnedNotesQueryKey>
  readonly previous: PinnedNote[] | undefined
}

/**
 * Apply an optimistic update to the pinned-notes cache and keep the previous
 * value for rollback. The markdown/index pipeline remains source of truth; this
 * only hides local write latency for sidebar interactions.
 */
export function updatePinnedNotesCache(
  queryClient: QueryClient,
  graphRoot: string,
  updater: (current: PinnedNote[] | undefined) => PinnedNote[] | undefined,
): PinnedNotesCacheSnapshot {
  const queryKey = pinnedNotesQueryKey(graphRoot)
  const previous = queryClient.getQueryData<PinnedNote[]>(queryKey)
  queryClient.setQueryData<PinnedNote[]>(queryKey, updater)
  return { queryKey, previous }
}

/** Restore a previous pinned-notes cache snapshot after a failed optimistic write. */
export function restorePinnedNotesCache(
  queryClient: QueryClient,
  snapshot: PinnedNotesCacheSnapshot,
): void {
  if (snapshot.previous !== undefined) {
    queryClient.setQueryData<PinnedNote[]>(snapshot.queryKey, snapshot.previous)
  }
}

/** Refetch pinned notes after rollback so the sidebar reconciles with the index. */
export function invalidatePinnedNotesCache(
  queryClient: QueryClient,
  snapshot: PinnedNotesCacheSnapshot,
): void {
  void queryClient.invalidateQueries({ queryKey: snapshot.queryKey })
}
