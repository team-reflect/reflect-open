import type { EmbedStatus } from '@reflect/core'
import { useEmbedStatus } from '@/lib/use-embed-status.ts'
import { useSemanticSearchEnabled, useSettingsService } from '@/providers/settings-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

export interface SemanticSearchControls {
  enabled: boolean
  status: EmbedStatus
  /**
   * Turn semantic search on. `EmbeddingsSync` loads an untouched runtime, and
   * this also retries a `failed` one.
   */
  enable: () => void
  disable: () => void
  /**
   * Load the model again after a failed load.
   */
  retry: () => void
}

/**
 * The semantic search setting (Plan 09) and the embedding runtime status that
 * the settings screens show.
 */
export function useSemanticSearchControls(): SemanticSearchControls {
  const enabled = useSemanticSearchEnabled()
  const settingsService = useSettingsService()
  const status = useEmbedStatus()
  const { semanticSearch } = useCoreServices()

  return {
    enabled,
    status,
    enable: () => {
      settingsService.update({ semanticSearchEnabled: true })
      void semanticSearch.retryFailedModel()
    },
    disable: () => settingsService.update({ semanticSearchEnabled: false }),
    retry: () => void semanticSearch.ensureModel(),
  }
}
