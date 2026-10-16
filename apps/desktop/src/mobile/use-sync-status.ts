import { useQuery } from '@tanstack/react-query'
import { mobileSyncStatus, type MobileSyncStatus } from '@reflect/app'
import { createConflictedNotesQueryOptions } from '@/lib/query-options.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useSyncContext } from '@/providers/sync-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * The mobile sync status, ready to display — engine state joined with the
 * graph's conflicted-note count (which outlives any one cycle). `null` when
 * there is nothing truthful to say: no backup configured, no sync lifecycle
 * mounted (dev harness, tests), or the conflict count still loading. The
 * derivation lives in app's `mobileSyncStatus`.
 *
 * One hook for both surfaces (settings sheet, status pill) so they share a
 * query cache entry and can never disagree.
 */
export function useMobileSyncStatus(): MobileSyncStatus | null {
  const { graph } = useGraph()
  const sync = useSyncContext()
  const { indexQuery, clock } = useCoreServices()
  const backup = sync?.backup ?? null
  const connected = backup !== null && backup.phase === 'connected'

  const { data: conflicted, isError: countUnavailable } = useQuery({
    ...createConflictedNotesQueryOptions(indexQuery, graph?.root),
    enabled: graph !== null && connected,
  })

  return mobileSyncStatus({
    backup,
    conflictCount: conflicted?.length,
    conflictCountUnavailable: countUnavailable,
    now: clock.now(),
  })
}
