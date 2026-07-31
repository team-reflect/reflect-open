import type { ReactElement } from 'react'
import { Trash2 } from 'lucide-react'
import {
  aiModelLabel,
  aiProvider,
  aiProviderRequiresApiKey,
  aiProviderSupportsChat,
  aiProviderSupportsTranscription,
  DEFAULT_CONTEXT_WINDOW,
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
 * operation). OpenAI-compatible rows always show a second model row for
 * transcription — picking the catalog's Disabled option (or clearing the
 * model) keeps the combo visible but greys out the default control; hosted
 * transcription-capable providers show their fixed model as an inert combo.
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
  const supportsChat = aiProviderSupportsChat(config)
  // The transcription combo always shows for openai-compatible — even when the
  // model is the disabled sentinel — so the user can re-enable it in place.
  const showTranscriptionControls = isOpenAICompatible || supportsTranscription

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
        {showTranscriptionControls ? (
          isOpenAICompatible ? (
            <ModelCombobox
              value={config.transcriptionModel}
              provider={config.provider}
              models={provider.models}
              onChange={(model) => onSetTranscriptionModel(config.id, model)}
              ariaLabel={`Transcription model for ${providerLabel}`}
            />
          ) : (
            <ModelCombobox
              value={transcriptionModelLabel(config)}
              provider={config.provider}
              models={[
                {
                  id: transcriptionModelLabel(config),
                  label: transcriptionModelLabel(config),
                  contextWindow: DEFAULT_CONTEXT_WINDOW,
                },
              ]}
              onChange={() => {}}
              ariaLabel={`Transcription model for ${providerLabel}`}
              disabled
            />
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
              disabled={!supportsChat}
              onClick={() => onMakeDefault(config.id)}
              className="shrink-0 text-text-secondary hover:bg-surface-hover hover:text-text"
            >
              Make default
            </Button>
          )}
        </div>
        {showTranscriptionControls ? (
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
                disabled={!supportsTranscription}
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
