import type { ReactElement } from 'react'
import { Trash2 } from 'lucide-react'
import { aiModelLabel, aiProvider, errorMessage, type AiProviderConfig } from '@reflect/core'
import { Button } from '@/components/ui/button'
import { startOperation } from '@/lib/operations'
import { ModelCombobox } from './model-combobox'

interface AiProviderRowProps {
  config: AiProviderConfig
  /** Whether this entry is the (resolved) app-wide default. */
  isDefault: boolean
  /** Make this entry the app-wide default. */
  onMakeDefault: (id: string) => void
  /** Change the default model used by this provider entry. */
  onSetDefaultModel: (id: string, model: string) => void
  /** Remove the entry and its keychain secret; rejects on failure. */
  onRemove: (id: string) => Promise<void>
}

/**
 * One configured AI provider in the settings list: provider + default model,
 * the stored key's trailing characters, and the default/remove controls. The
 * row owns its own removal (including surfacing a keychain failure as an
 * operation).
 */
export function AiProviderRow({
  config,
  isDefault,
  onMakeDefault,
  onSetDefaultModel,
  onRemove,
}: AiProviderRowProps): ReactElement {
  const provider = aiProvider(config.provider)
  const providerLabel = provider.label
  const modelLabel = aiModelLabel(config.provider, config.model)
  const name = `${providerLabel} — ${modelLabel}`

  const remove = (): void => {
    onRemove(config.id).catch((error: unknown) => {
      startOperation(`Removing ${name}`).fail(errorMessage(error))
    })
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_12rem_auto] items-center gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-text">{providerLabel}</div>
        <p className="mt-0.5 text-xs text-text-muted">
          API key <span className="font-mono">·····{config.keyHint}</span>
        </p>
      </div>
      <ModelCombobox
        value={config.model}
        provider={config.provider}
        models={provider.models}
        onChange={(model) => onSetDefaultModel(config.id, model)}
        ariaLabel={`Default model for ${providerLabel}`}
      />
      <div className="flex shrink-0 items-center gap-2">
        {isDefault ? (
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-soft-text">
            Default
          </span>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => onMakeDefault(config.id)}
            className="text-text-secondary hover:bg-surface-hover hover:text-text"
          >
            Make default
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${name}`}
          onClick={remove}
          className="text-text-muted hover:bg-surface-hover hover:text-text"
        >
          <Trash2 aria-hidden strokeWidth={1.75} />
        </Button>
      </div>
    </div>
  )
}
