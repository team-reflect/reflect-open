import { QueryClient } from '@tanstack/react-query'

/**
 * The app's one TanStack Query client (adopted in Plan 07 per architecture
 * conventions §5): `queryFn`s are `@reflect/core` getters over the SQLite
 * projection, so freshness is event-driven, not poll-driven — the graph index
 * lifecycle calls {@link invalidateIndexQueries} after rows actually change
 * (initial reconcile, then each applied watcher batch).
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Index reads are local SQLite over IPC: cheap, and kept fresh by
      // invalidation. Treat cached data as good until an invalidation says
      // otherwise; never refetch just because a window regained focus.
      staleTime: Infinity,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

/** Every index-backed query nests under this key (e.g. `['index', 'backlinks', path]`). */
export const INDEX_QUERY_SCOPE = 'index'

/** Refetch all index-backed queries; called after index rows change. */
export function invalidateIndexQueries(): void {
  void queryClient.invalidateQueries({ queryKey: [INDEX_QUERY_SCOPE] })
}

/**
 * Minimum spacing between full index-query refetch rounds on the batch
 * paths. During an initial iCloud sync the watch applies a batch every
 * couple of seconds for minutes; refetching every mounted index query per
 * batch is a large share of what makes a first sync feel slow.
 */
const INVALIDATE_THROTTLE_MS = 3_000

let lastInvalidateAt = 0
let invalidateTimer: ReturnType<typeof setTimeout> | null = null

/**
 * {@link invalidateIndexQueries} with leading+trailing throttling, for the
 * *streaming* callers (applied watcher batches, sweep/pull reindexes): an
 * isolated call fires immediately — a single save keeps its instant refresh
 * — while a burst collapses to one refetch per window, none dropped (the
 * trailing edge always runs). Direct user-action invalidations should keep
 * calling the unthrottled function.
 */
export function throttledInvalidateIndexQueries(): void {
  const now = Date.now()
  const elapsed = now - lastInvalidateAt
  if (elapsed >= INVALIDATE_THROTTLE_MS) {
    lastInvalidateAt = now
    invalidateIndexQueries()
    return
  }
  if (invalidateTimer !== null) {
    return // a trailing refetch is already on its way
  }
  invalidateTimer = setTimeout(() => {
    invalidateTimer = null
    lastInvalidateAt = Date.now()
    invalidateIndexQueries()
  }, INVALIDATE_THROTTLE_MS - elapsed)
}

/** The iCloud container listing (`icloud_status`) — read by the graph chooser and Settings → iCloud. */
export const ICLOUD_STATUS_QUERY_KEY = ['icloud-status'] as const

/**
 * Forget the cached iCloud container listing after its contents change (a
 * graph delete trashes a container directory). Removal rather than
 * invalidation: with an invalidated cache the chooser would render the stale
 * list — deleted graph included — while the refetch runs.
 */
export function dropIcloudStatusQuery(): void {
  queryClient.removeQueries({ queryKey: ICLOUD_STATUS_QUERY_KEY })
}

/** Chat-history queries nest under this key (e.g. `['chat', 'conversations', root]`). */
export const CHAT_QUERY_SCOPE = 'chat'

/** Refetch chat-history queries; called after a turn save or a delete. */
export function invalidateChatQueries(): void {
  void queryClient.invalidateQueries({ queryKey: [CHAT_QUERY_SCOPE] })
}
