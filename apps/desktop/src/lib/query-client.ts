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

/** Chat-history queries nest under this key (e.g. `['chat', 'conversations', root]`). */
export const CHAT_QUERY_SCOPE = 'chat'

/** Refetch chat-history queries; called after a turn save or a delete. */
export function invalidateChatQueries(): void {
  void queryClient.invalidateQueries({ queryKey: [CHAT_QUERY_SCOPE] })
}
