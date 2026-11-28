import type { ReactElement } from 'react'
import type { EmbedStatus, EmbeddingProgress } from '@reflect/core'
import { useSemanticSearchControls } from '@/lib/use-semantic-search-controls.ts'
import { useStore } from '@/lib/use-store.ts'
import { useCoreServices } from '@/services/services-provider.tsx'
import {
  SettingsActionRow,
  SettingsGroup,
  SettingsSwitchRow,
  SettingsValueRow,
} from './settings-list.tsx'

const FOOTER_ID = 'semantic-search-footer'

function statusLabel(status: EmbedStatus, progress: EmbeddingProgress | null): string {
  switch (status.status) {
    case 'loading':
      return status.progress !== undefined &&
        status.progress.total > 0 &&
        status.progress.downloaded < status.progress.total
        ? `Downloading ${Math.floor((status.progress.downloaded / status.progress.total) * 100)}%`
        : 'Preparing'
    case 'ready':
      return progress !== null && progress.done < progress.total
        ? `Indexing ${progress.done} of ${progress.total} notes`
        : 'Ready'
    case 'failed':
      return 'Failed'
    default:
      return 'Preparing'
  }
}

/**
 * The semantic search group of the mobile settings: the opt-in switch, the
 * model download and the first indexing pass. Hidden where the runtime is
 * `unsupported`.
 */
export function SemanticSearchGroup(): ReactElement | null {
  const { enabled, status, enable, disable, retry } = useSemanticSearchControls()
  const { semanticSearch } = useCoreServices()
  const progress = useStore(semanticSearch.progress)

  if (status.status === 'unsupported') {
    return null
  }

  const footer =
    enabled && status.status === 'failed'
      ? `Couldn’t load the model: ${status.message}`
      : 'Find notes by meaning in search and AI chat. It runs on this device. Turning it on downloads a model of about 330 MB once, so use Wi-Fi.'

  return (
    <SettingsGroup header="Search" footer={footer} footerId={FOOTER_ID}>
      <SettingsSwitchRow
        label="Semantic search"
        checked={enabled}
        onCheckedChange={(checked) => (checked ? enable() : disable())}
        descriptionId={FOOTER_ID}
      />
      {enabled ? <SettingsValueRow label="Status" value={statusLabel(status, progress)} /> : null}
      {enabled && status.status === 'failed' ? (
        <SettingsActionRow label="Try again" onPress={retry} />
      ) : null}
    </SettingsGroup>
  )
}
