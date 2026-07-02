import { useQuery } from '@tanstack/react-query'
import { getConflictedNotes, hasBridge } from '@reflect/core'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { mobileSyncStatus, type MobileSyncStatus } from '@/mobile/sync-status'
import { useGraph } from '@/providers/graph-provider'
import { useSyncContext } from '@/providers/sync-provider'

/**
 * The mobile sync status, ready to display — engine state joined with the
 * graph's conflicted-note count (which outlives any one cycle). `null` when
 * there is nothing truthful to say: no backup configured, no sync lifecycle
 * mounted (dev harness, tests), or the conflict count still loading — a
 * status shown before the count is known could claim `Backed up` over
 * conflict markers already on disk, then flip.
 *
 * One hook for both surfaces (settings sheet, status pill) so they share a
 * query cache entry and can never disagree.
 */
export function useMobileSyncStatus(): MobileSyncStatus | null {
  const { graph } = useGraph()
  const sync = useSyncContext()
  const backup = sync?.backup ?? null
  const connected = backup !== null && backup.phase === 'connected'

  const { data: conflicted, isError: countUnavailable } = useQuery({
    queryKey: [INDEX_QUERY_SCOPE, graph?.root, 'conflicted-notes'],
    queryFn: getConflictedNotes,
    enabled: hasBridge() && graph !== null && connected,
  })

  // Loading hides the status (no flip); a *failed* count must not — the
  // engine-driven states (Syncing, Offline, Needs attention) don't depend on
  // it, and blanking them over an unreadable index would hide real signal.
  // The degradation is losing the Needs-review headline until the index
  // recovers.
  if (backup === null || (connected && conflicted === undefined && !countUnavailable)) {
    return null
  }
  return mobileSyncStatus(backup, conflicted?.length ?? 0)
}
