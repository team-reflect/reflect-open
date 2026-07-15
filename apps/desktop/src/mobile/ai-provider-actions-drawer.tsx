import { useState, type ReactElement } from 'react'
import { aiModelLabel, aiProvider, errorMessage, type AiProviderConfig } from '@reflect/core'
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer'
import { SettingsActionRow, SettingsGroup, SettingsSelectRow } from '@/mobile/settings-list'

interface AiProviderActionsDrawerProps {
  /** The provider the sheet manages; null renders nothing (exit animation). */
  provider: AiProviderConfig | null
  /** Whether that provider is the current app default. */
  isDefault: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onMakeDefault: (id: string) => void
  onSetDefaultModel: (id: string, model: string) => void
  /** Delete the key from the keychain, then drop the settings entry. */
  onRemove: (id: string) => Promise<void>
}

/**
 * The per-provider management sheet (the {@link NoteActionsMenu} pattern):
 * tapping a configured provider row in Settings offers make-default and
 * remove. Removing deletes the keychain entry first, exactly like desktop —
 * both actions come from `useAiProviders`, this is only the touch shell.
 */
export function AiProviderActionsDrawer({
  provider,
  isDefault,
  open,
  onOpenChange,
  onMakeDefault,
  onSetDefaultModel,
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
            <DrawerTitle className="px-4 pt-1">
              {`${providerInfo.label} ·····${provider.keyHint}`}
            </DrawerTitle>
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
              <SettingsGroup>
                <SettingsActionRow
                  label={isDefault ? 'Default provider' : 'Use as default'}
                  disabled={isDefault}
                  onPress={() => {
                    onMakeDefault(provider.id)
                    onOpenChange(false)
                  }}
                />
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
