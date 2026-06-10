import type { ReactElement, ReactNode } from 'react'
import { Sparkles } from 'lucide-react'
import { InlineAlert } from '@/components/inline-alert'
import { ensureEmbeddingsVisibly, retryFailedEmbeddings } from '@/lib/semantic'
import { useEmbedStatus } from '@/lib/use-embed-status'
import { useSettings } from '@/providers/settings-provider'
import { SettingsField } from './field'
import { ModelDownloadProgress } from './model-download-progress'
import { SettingsSection } from './section'

/**
 * The search settings: the semantic-search opt-in (Plan 09). Enabling
 * persists `semanticSearchEnabled`; EmbeddingsSync reacts by loading the
 * model, and the first load's ~90MB download streams through this section as
 * a progress bar (the `embed:status` events carry byte counts).
 */
export function SearchSection(): ReactElement {
  const { settings, updateSettings } = useSettings()
  const status = useEmbedStatus()

  let control: ReactNode
  if (!settings.semanticSearchEnabled) {
    control = (
      <div>
        <button
          type="button"
          onClick={() => {
            updateSettings({ semanticSearchEnabled: true })
            // EmbeddingsSync loads an untouched runtime; a `failed` one only
            // retries on an explicit action like this.
            void retryFailedEmbeddings()
          }}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-text-on-brand shadow-sm transition-colors duration-100 hover:bg-accent-hover"
        >
          <Sparkles aria-hidden strokeWidth={1.75} className="size-3.5" />
          Enable semantic search
        </button>
        {status.status === 'ready' ? (
          <p className="mt-2 text-xs text-text-muted">
            The model is still loaded for this session; disabling takes full effect on the next
            launch.
          </p>
        ) : null}
      </div>
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
          onClick={() => updateSettings({ semanticSearchEnabled: false })}
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
            onClick={() => void ensureEmbeddingsVisibly()}
            className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors duration-100 hover:bg-surface-hover"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => updateSettings({ semanticSearchEnabled: false })}
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
    <SettingsSection title="Search">
      <SettingsField
        legend="Semantic search"
        description="Find notes by meaning, not just keywords — smarter ⌘K results and related notes. Runs entirely on this device; enabling downloads a small model (~90 MB) once."
      >
        <div className="mt-3">{control}</div>
      </SettingsField>
    </SettingsSection>
  )
}
