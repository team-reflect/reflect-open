import type { EmbeddingProgress, EmbedStatus } from '@reflect/core'
import { useEmbedStatus } from '@/lib/use-embed-status.ts'
import { useStore } from '@/lib/use-store.ts'
import { useSemanticSearchEnabled, useSettingsService } from '@/providers/settings-provider.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

export const SEMANTIC_SEARCH_DESCRIPTION = 'Find notes by meaning, not just keywords.'

const DOWNLOAD_CONSENT = {
  title: 'Download over cellular?',
  message: 'Semantic search downloads a 330 MB model',
  confirm: 'Download',
  cancel: 'Not Now',
}

/**
 * Where semantic search is, as both settings screens show it.
 */
export type SemanticSearchPhase =
  | { kind: 'unsupported' }
  | { kind: 'off' }
  | { kind: 'waiting' }
  | { kind: 'preparing' }
  | { kind: 'downloading'; fraction: number }
  | { kind: 'indexing'; done: number; total: number }
  | { kind: 'ready' }
  | { kind: 'failed'; message: string }

export interface SemanticSearchControls {
  phase: SemanticSearchPhase
  /**
   * Turn semantic search on. It asks first in a system alert when that
   * downloads the model over an expensive connection, and it also retries a
   * `failed` load.
   */
  enable: () => void
  disable: () => void
  /**
   * Load the model again after a failed load, or ask first like `enable`.
   */
  retry: () => void
  /**
   * Download the model over the expensive connection that the load waits on.
   */
  downloadNow: () => void
}

function phaseOf(
  enabled: boolean,
  status: EmbedStatus,
  waiting: boolean,
  progress: EmbeddingProgress | null,
): SemanticSearchPhase {
  if (status.status === 'unsupported') {
    return { kind: 'unsupported' }
  }
  if (!enabled) {
    return { kind: 'off' }
  }
  switch (status.status) {
    case 'loading': {
      const bytes = status.progress
      return bytes !== undefined && bytes.total > 0 && bytes.downloaded < bytes.total
        ? { kind: 'downloading', fraction: bytes.downloaded / bytes.total }
        : { kind: 'preparing' }
    }
    case 'ready':
      return progress !== null && progress.done < progress.total
        ? { kind: 'indexing', done: progress.done, total: progress.total }
        : { kind: 'ready' }
    case 'failed':
      return { kind: 'failed', message: status.message }
    default:
      return waiting ? { kind: 'waiting' } : { kind: 'preparing' }
  }
}

/**
 * The status text of a phase that semantic search is on in.
 */
export function semanticSearchStatusLabel(phase: SemanticSearchPhase): string {
  switch (phase.kind) {
    case 'waiting':
      return 'Waiting for Wi-Fi'
    case 'downloading':
      return `Downloading ${Math.floor(phase.fraction * 100)}%`
    case 'indexing':
      return `Indexing ${phase.done} of ${phase.total} notes`
    case 'ready':
      return 'Ready'
    case 'failed':
      return 'Failed'
    default:
      return 'Preparing'
  }
}

/**
 * The semantic search setting (Plan 09), the embedding runtime status, and
 * the first indexing pass, as one phase with the actions of both settings
 * screens.
 */
export function useSemanticSearchControls(): SemanticSearchControls {
  const enabled = useSemanticSearchEnabled()
  const settingsService = useSettingsService()
  const status = useEmbedStatus()
  const { semanticSearch } = useCoreServices()
  const { dialog } = useAppServices()
  const waiting = useStore(semanticSearch.waitingForNetwork)
  const progress = useStore(semanticSearch.progress)

  const turnOn = (): void => {
    settingsService.update({ semanticSearchEnabled: true })
    void semanticSearch.retryFailedModel()
  }
  const reload = (): void => {
    void semanticSearch.ensureModel()
  }
  const askFirst = async (load: () => void): Promise<void> => {
    if (await semanticSearch.needsDownloadConsent()) {
      if (!(await dialog.confirm(DOWNLOAD_CONSENT))) {
        return
      }
      semanticSearch.allowExpensiveDownload()
    }
    load()
  }

  return {
    phase: phaseOf(enabled, status, waiting, progress),
    enable: () => void askFirst(turnOn),
    disable: () => settingsService.update({ semanticSearchEnabled: false }),
    retry: () => void askFirst(reload),
    downloadNow: () => semanticSearch.allowExpensiveDownload(),
  }
}
