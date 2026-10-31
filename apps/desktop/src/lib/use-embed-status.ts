import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { EmbedStatus, Unlisten } from '@reflect/core'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * The embedding runtime's live status (Plan 09). Polls once on mount, then
 * tracks `embed:status` events; a later mount starts from the last status
 * the runtime observed.
 */
export function useEmbedStatus(): EmbedStatus {
  const { embeddingRuntime } = useCoreServices()
  const subscribe = useCallback(
    (onChange: () => void): Unlisten => embeddingRuntime.subscribe(onChange),
    [embeddingRuntime],
  )

  const getSnapshot = useCallback(() => embeddingRuntime.lastStatus(), [embeddingRuntime])

  useEffect(() => {
    void embeddingRuntime.status()
  }, [embeddingRuntime])

  return useSyncExternalStore(subscribe, getSnapshot)
}
