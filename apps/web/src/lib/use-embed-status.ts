import { useEffect } from 'react'
import type { EmbedStatus } from '@reflect/core'
import { useStore } from '@/lib/use-store.ts'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * The embedding runtime's live status (Plan 09). Polls once on mount, then
 * tracks `embed:status` events; a later mount starts from the last status
 * the runtime observed.
 */
export function useEmbedStatus(): EmbedStatus {
  const { embeddingRuntime } = useCoreServices()
  useEffect(() => {
    void embeddingRuntime.status()
  }, [embeddingRuntime])

  return useStore(embeddingRuntime)
}
