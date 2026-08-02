import { useState, type ReactElement } from 'react'
import {
  aiModelLabel,
  aiProvider,
  aiProviderRequiresApiKey,
  aiProviderSupportsChat,
  aiProviderSupportsTranscription,
  errorMessage,
  GOOGLE_TRANSCRIPTION_MODEL,
  OPENAI_TRANSCRIPTION_MODEL,
  type AiProviderConfig,
} from '@reflect/core'
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer'
import { Input } from '@/components/ui/input'
import { SettingsActionRow, SettingsGroup, SettingsSelectRow } from '@/mobile/settings-list'

interface AiProviderActionsDrawerProps {
  /** The provider the sheet manages; null renders nothing (exit animation). */
  provider: AiProviderConfig | null
  /** Whether that provider is the current chat default. */
  isDefault: boolean
  /** Whether that provider is the current transcription default. */
  isTranscriptionDefault: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onMakeDefault: (id: string) => void
  onSetDefaultModel: (id: string, model: string) => void
  onSetTranscriptionModel: (id: string, model: string) => void
  onMakeTranscriptionDefault: (id: string) => void
  /** Delete the key from the keychain, then drop the settings entry. */
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

/** A key-change-aware input that resets its draft when the provider changes. */
function TranscriptionModelInput({
  provider,
  onSetTranscriptionModel,
}: {
  provider: Extract<AiProviderConfig, { provider: 'openai-compatible' }>
  onSetTranscriptionModel: (id: string, model: string) => void
}): ReactElement {
  const [draft, setDraft] = useState(provider.transcriptionModel)
  return (
    <Input
      aria-label="Transcription model"
      autoComplete="off"
      spellCheck={false}
      placeholder="Model id, or 'disabled'"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const next = draft.trim()
        if (next !== provider.transcriptionModel) {
          onSetTranscriptionModel(provider.id, next)
        }
      }}
    />
  )
}

/**
 * The per-provider management sheet (the {@link NoteActionsMenu} pattern):
 * tapping a configured provider row in Settings offers make-default, remove,
 * and model selection for both chat and transcription. Removing deletes the
 * keychain entry first, exactly like desktop — both actions come from
 * `useAiProviders`, this is only the touch shell.
 */
export function AiProviderActionsDrawer({
  provider,
  isDefault,
  isTranscriptionDefault,
  open,
  onOpenChange,
  onMakeDefault,
  onSetDefaultModel,
  onSetTranscriptionModel,
  onMakeTranscriptionDefault,
  onRemove,
}: AiProviderActionsDrawerProps): ReactElement {
  const [removing, setRemoving] = useState(false)
  const providerInfo = provider === null ? null : aiProvider(provider.provider)
  const models =
    provider === null || providerInfo === null
      ? []
      : providerInfo.models.some((model) => model.id === provider.model)
        ? providerInfo.models
        : [
            {
              id: provider.model,
              label: aiModelLabel(provider.provider, provider.model),
            },
            ...providerInfo.models,
          ]
  const supportsTranscription = provider !== null && aiProviderSupportsTranscription(provider)
  const isOpenAICompatible = provider?.provider === 'openai-compatible'
  const supportsChat = provider !== null && aiProviderSupportsChat(provider)
  // Keep the transcription section visible for openai-compatible even when the
  // model is disabled, so the user can re-enable it without re-adding the entry.
  const showTranscriptionControls = isOpenAICompatible || supportsTranscription
  const title =
    provider === null || providerInfo === null
      ? ''
      : aiProviderRequiresApiKey(provider.provider) || provider.keyHint !== ''
        ? `${providerInfo.label} ·····${provider.keyHint}`
        : `${providerInfo.label} · No API key`

  // A failed removal (keychain write, settings store) keeps the sheet open —
  // closing would read as success — and logs; the row is still there to retry.
  const remove = async (id: string): Promise<void> => {
    setRemoving(true)
    try {
      await onRemove(id)
      onOpenChange(false)
    } catch (cause) {
      console.error('AI provider removal failed:', errorMessage(cause))
    } finally {
      setRemoving(false)
    }
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent aria-label="Manage AI provider">
        {provider !== null && providerInfo !== null ? (
          <>
            <DrawerTitle className="px-4 pt-1">{title}</DrawerTitle>
            <div className="flex flex-col gap-6 px-4 pb-8 pt-4">
              <SettingsGroup header="Default model">
                {models.map((model) => (
                  <SettingsSelectRow
                    key={model.id}
                    label={model.label}
                    selected={model.id === provider.model}
                    onPress={() => {
                      onSetDefaultModel(provider.id, model.id)
                      onOpenChange(false)
                    }}
                  />
                ))}
              </SettingsGroup>

              {showTranscriptionControls ? (
                <SettingsGroup header="Transcription model">
                  {isOpenAICompatible ? (
                    <div className="px-4 py-2">
                      <TranscriptionModelInput
                        key={provider.id}
                        provider={provider}
                        onSetTranscriptionModel={onSetTranscriptionModel}
                      />
                    </div>
                  ) : (
                    <SettingsSelectRow
                      label={transcriptionModelLabel(provider)}
                      selected
                      disabled
                      onPress={() => {}}
                    />
                  )}
                </SettingsGroup>
              ) : null}

              <SettingsGroup>
                <SettingsActionRow
                  label={isDefault ? 'Default for chat' : 'Use as default for chat'}
                  disabled={isDefault || !supportsChat}
                  onPress={() => {
                    onMakeDefault(provider.id)
                    onOpenChange(false)
                  }}
                />
                {showTranscriptionControls ? (
                  <SettingsActionRow
                    label={
                      isTranscriptionDefault
                        ? 'Default for transcription'
                        : 'Use as default for transcription'
                    }
                    disabled={isTranscriptionDefault || !supportsTranscription}
                    onPress={() => {
                      onMakeTranscriptionDefault(provider.id)
                      onOpenChange(false)
                    }}
                  />
                ) : null}
                <SettingsActionRow
                  label="Remove provider"
                  tone="destructive"
                  pending={removing}
                  onPress={() => void remove(provider.id)}
                />
              </SettingsGroup>
            </div>
          </>
        ) : null}
      </DrawerContent>
    </Drawer>
  )
}
