import type { ReactElement } from 'react'
import { Trash2 } from 'lucide-react'
import {
  aiModelLabel,
  aiProvider,
  aiProviderRequiresApiKey,
  aiProviderSupportsTranscription,
  errorMessage,
  GOOGLE_TRANSCRIPTION_MODEL,
  OPENAI_TRANSCRIPTION_MODEL,
  type AiProviderConfig,
} from '@reflect/core'
import { Button } from '@/components/ui/button'
import { startOperation } from '@/lib/operations'
import { ModelCombobox } from './model-combobox'

interface AiProviderRowProps {
  config: AiProviderConfig
  /** Whether this entry is the (resolved) app-wide default. */
  isDefault: boolean
  /** Whether this entry is the transcription default. */
  isTranscriptionDefault: boolean
  /** Make this entry the app-wide default. */
  onMakeDefault: (id: string) => void
  /** Change the default model used by this provider entry. */
  onSetDefaultModel: (id: string, model: string) => void
  /** Change the transcription model used by this provider entry. */
  onSetTranscriptionModel: (id: string, model: string) => void
  /** Make this entry the transcription default. */
  onMakeTranscriptionDefault: (id: string) => void
  /** Remove the entry and its keychain secret; rejects on failure. */
  onRemove: (id: string) => Promise<void>
}

function transcriptionModelLabel(config: AiProviderConfig): string {
  if (config.provider === 'openai') {
    return OPENAI_TRANSCRIPTION_MODEL
  }
  if (config.provider === 'google') {
    return GOOGLE_TRANSCRIPTION_MODEL
  }
  if (config.provider === 'openai-compatible') {
    return config.transcriptionModel
  }
  return ''
}

/**
 * One configured AI provider in the settings list: provider + default model,
 * the stored key's trailing characters, and the default/remove controls. The
 * row owns its own removal (including surfacing a keychain failure as an
 * operation). Transcription-capable providers show a second row with the
 * transcription model and default control.
 */
export function AiProviderRow({
  config,
  isDefault,
  isTranscriptionDefault,
  onMakeDefault,
  onSetDefaultModel,
  onSetTranscriptionModel,
  onMakeTranscriptionDefault,
  onRemove,
}: AiProviderRowProps): ReactElement {
  const provider = aiProvider(config.provider)
  const providerLabel = provider.label
  const modelLabel = aiModelLabel(config.provider, config.model)
  const name = `${providerLabel} — ${modelLabel}`
  const showKeyHint = aiProviderRequiresApiKey(config.provider) || config.keyHint !== ''
  const supportsTranscription = aiProviderSupportsTranscription(config)
  const isOpenAICompatible = config.provider === 'openai-compatible'

  const remove = (): void => {
    onRemove(config.id).catch((error: unknown) => {
      startOperation(`Removing ${name}`).fail(errorMessage(error))
    })
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-start gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-text">{providerLabel}</div>
        <p className="mt-0.5 text-xs text-text-muted">
          {showKeyHint ? (
            <>
              API key <span className="font-mono">·····{config.keyHint}</span>
            </>
          ) : (
            'No API key'
          )}
        </p>
        {config.provider === 'openai-compatible' ? (
          <p className="mt-0.5 truncate text-xs text-text-muted">{config.baseUrl}</p>
        ) : null}
      </div>

      <div className="flex flex-col items-end gap-1.5">
        <ModelCombobox
          value={config.model}
          provider={config.provider}
          models={provider.models}
          onChange={(model) => onSetDefaultModel(config.id, model)}
          ariaLabel={`Default model for ${providerLabel}`}
        />
        {supportsTranscription ? (
          isOpenAICompatible ? (
            <ModelCombobox
              value={config.transcriptionModel}
              provider={config.provider}
              models={[]}
              onChange={(model) => onSetTranscriptionModel(config.id, model)}
              ariaLabel={`Transcription model for ${providerLabel}`}
            />
          ) : (
            <span className="text-xs text-text-muted">{transcriptionModelLabel(config)}</span>
          )
        ) : null}
      </div>

      <div className="flex flex-col items-end gap-1.5">
        <div className="flex h-8 items-center">
          {isDefault ? (
            <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-soft-text">
              Default
            </span>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => onMakeDefault(config.id)}
              className="shrink-0 text-text-secondary hover:bg-surface-hover hover:text-text"
            >
              Make default
            </Button>
          )}
        </div>
        {supportsTranscription ? (
          <div className="flex h-8 items-center">
            {isTranscriptionDefault ? (
              <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-soft-text">
                Transcription default
              </span>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onMakeTranscriptionDefault(config.id)}
                className="shrink-0 text-text-secondary hover:bg-surface-hover hover:text-text"
              >
                Make transcription default
              </Button>
            )}
          </div>
        ) : null}
      </div>

      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove ${name}`}
        onClick={remove}
        className="self-center text-text-muted hover:bg-surface-hover hover:text-text"
      >
        <Trash2 aria-hidden strokeWidth={1.75} />
      </Button>
    </div>
  )
}
