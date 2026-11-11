import type { AppServices } from '@reflect/app'
import type { CoreServices, Unlisten } from '@reflect/core'
import {
  dropIcloudStatusQuery,
  dropSimilarNotesQueries,
  dropXPostQueries,
  invalidateChatQueries,
  invalidateIndexQueries,
  invalidateXPostQueries,
  throttledInvalidateIndexQueries,
} from '@/lib/query-client.ts'

/**
 * Invalidate the queries that service events make stale. Queries cache
 * forever (`staleTime: Infinity`), so each write must signal here: the
 * index-backed queries after index changes and new asset descriptions,
 * archived X posts after a capture pass, the chat history after a saved turn,
 * and what the app holds per graph when graphs change.
 */
export function installQueryInvalidation(core: CoreServices, { window }: AppServices): Unlisten {
  const unlisteners = [
    core.capture.onXPostsWritten(invalidateXPostQueries),
    core.assetDescription.onDescriptionsIndexed(invalidateIndexQueries),
    // The history menus list conversations through React Query.
    core.chatSessions.onConversationsChanged(invalidateChatQueries),
    // Applied watcher batches stream every couple of seconds during a bulk
    // sync — the throttled variant collapses them to one refetch round per
    // window (an isolated batch still invalidates immediately).
    core.indexLifecycle.onApplied(throttledInvalidateIndexQueries),
    core.indexLifecycle.onReconciled((event) => {
      // A manual rebuild bypasses the watcher pipeline (whose onApplied
      // refreshes the caches), so cached note lists, backlinks, and tags
      // would otherwise show pre-rebuild rows until some unrelated change
      // invalidated them.
      if (event.source !== 'sync') {
        invalidateIndexQueries()
      }
    }),
    // On a switch, the session-held "Similar notes" results of the prior graph go.
    core.graphSession.onGraphReleased((reason) => {
      if (reason === 'switch') {
        dropSimilarNotesQueries()
      }
    }),
    core.graphSession.onGraphReleased(dropXPostQueries),
    // The delete trashed a directory the chooser may list: drop the cached
    // iCloud listing so the chooser refetches it rather than showing the
    // deleted graph.
    core.graphSession.onGraphDeleted(dropIcloudStatusQuery),
  ]
  if (!window.isMainWindow()) {
    // A note window runs no indexer: the Rust `index:written` broadcast
    // (fired after the main window's applies commit) keeps its index-backed
    // queries fresh.
    unlisteners.push(window.subscribeIndexWritten(throttledInvalidateIndexQueries))
  }
  return () => {
    for (const unlisten of unlisteners) {
      unlisten()
    }
  }
}
