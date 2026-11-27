import { APP_COMMANDS } from '@reflect/app'
import type { ReactElement, ReactNode } from 'react'
import { Sparkles } from 'lucide-react'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { useSemanticSearchControls } from '@/lib/use-semantic-search-controls.ts'
import { useAppServices } from '@/services/services-provider.tsx'
import { DescribeAssetsField } from './describe-assets-field.tsx'
import { SettingsField } from './field.tsx'
import { ModelDownloadProgress } from './model-download-progress.tsx'
import { RebuildIndexField } from './rebuild-index-field.tsx'
import { SettingsSection } from './section.tsx'

const PALETTE_BINDING = APP_COMMANDS['palette.open'].keybinding

/**
 * The search settings: the semantic-search opt-in (Plan 09) and the index
 * rebuild action. Enabling semantic search persists `semanticSearchEnabled`;
 * EmbeddingsSync reacts by loading the model, and the first load's
 * download streams through this section as a progress bar (the `embed:status`
 * events carry byte counts).
 */
export function SearchSection(): ReactElement {
  const { enabled, status, enable, disable, retry } = useSemanticSearchControls()
  const { keymap } = useAppServices()

  let control: ReactNode
  if (status.status === 'unsupported') {
    control = (
      <p className="text-xs text-text-muted">Semantic search is not available on this device.</p>
    )
  } else if (!enabled) {
    // Disabling takes effect immediately — every semantic consumer gates on
    // the setting, so the still-loaded model just idles. No caveat needed.
    control = (
      <button
        type="button"
        onClick={enable}
        className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-text-on-brand shadow-sm transition-colors duration-100 hover:bg-accent-hover"
      >
        <Sparkles aria-hidden strokeWidth={1.75} className="size-3.5" />
        Enable semantic search
      </button>
    )
  } else if (status.status === 'ready') {
    control = (
      <div className="flex items-center justify-between gap-4">
        <span className="flex items-center gap-2 text-xs text-text-muted">
          <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
          Model downloaded ({status.model})
        </span>
        <button
          type="button"
          onClick={disable}
          className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors duration-100 hover:bg-surface-hover"
        >
          Disable
        </button>
      </div>
    )
  } else if (status.status === 'failed') {
    control = (
      <div>
        <InlineAlert tone="error">Couldn’t load the model: {status.message}</InlineAlert>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={retry}
            className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors duration-100 hover:bg-surface-hover"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={disable}
            className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors duration-100 hover:bg-surface-hover"
          >
            Disable
          </button>
        </div>
      </div>
    )
  } else {
    // `loading`, or the `uninitialized` beat before EmbeddingsSync reacts.
    control = (
      <ModelDownloadProgress progress={status.status === 'loading' ? status.progress : undefined} />
    )
  }

  return (
    <SettingsSection id="search">
      <SettingsField
        legend="Semantic search"
        description={`Find notes by meaning, not just keywords — smarter ${keymap.formatLabel(PALETTE_BINDING)} results and related notes. Runs entirely on this device; enabling downloads a model (~330 MB) once.`}
      >
        <div className="mt-3">{control}</div>
      </SettingsField>
      <DescribeAssetsField />
      <RebuildIndexField />
    </SettingsSection>
  )
}
