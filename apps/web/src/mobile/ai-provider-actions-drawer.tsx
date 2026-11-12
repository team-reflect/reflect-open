import type { ReactElement } from 'react'
import {
  aiModelLabel,
  aiProvider,
  aiProviderRequiresApiKey,
  errorMessage,
  type AiProviderConfig,
} from '@reflect/core'
import { Drawer, DrawerContent, DrawerTitle } from '@/mobile/scroll-drawer.tsx'
import { useAsyncAction } from '@/hooks/use-async-action.ts'
import { SettingsActionRow, SettingsGroup, SettingsSelectRow } from '@/mobile/settings-list.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'
import { useNativeMenuDrawer } from '@/mobile/native-chrome/native-menu.ts'
import { useToastController } from '@/lib/use-toasts.ts'

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
  const { logger } = useCoreServices()
  const toastController = useToastController()
  const { run, pending: removing } = useAsyncAction()
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
  const title =
    provider === null || providerInfo === null
      ? ''
      : aiProviderRequiresApiKey(provider.provider) || provider.keyHint !== ''
        ? `${providerInfo.label} ·····${provider.keyHint}`
        : `${providerInfo.label} · No API key`

  // A failed removal (keychain write, settings store) keeps the sheet open —
  // closing would read as success — and logs; the row is still there to retry.
  const remove = async (id: string): Promise<void> => {
    await run(async () => {
      try {
        await onRemove(id)
        onOpenChange(false)
      } catch (cause) {
        logger.error('AI provider removal failed:', errorMessage(cause))
      }
    })
  }

  const nativeMenu = useNativeMenuDrawer({
    open,
    onOpenChange,
    menuId: 'ai-provider-actions',
    items:
      provider === null
        ? []
        : [
            {
              type: 'section',
              title: 'Default model',
              items: models.map((model) => ({
                type: 'action',
                id: `model:${model.id}`,
                title: model.label,
                checked: model.id === provider.model,
              })),
            },
            {
              type: 'section',
              items: [
                {
                  type: 'action',
                  id: 'default',
                  title: isDefault ? 'Default provider' : 'Use as default',
                  disabled: isDefault,
                },
                {
                  type: 'action',
                  id: 'remove',
                  title: 'Remove provider',
                  destructive: true,
                  confirm: {
                    title: `Remove ${providerInfo?.label ?? 'this provider'}?`,
                    message: 'Its API key is deleted from this device.',
                    action: 'Remove',
                  },
                },
              ],
            },
          ],
    onSelect: (id) => {
      if (provider === null) {
        return
      }
      if (id.startsWith('model:')) {
        onSetDefaultModel(provider.id, id.slice('model:'.length))
      } else if (id === 'default') {
        onMakeDefault(provider.id)
      } else if (id === 'remove') {
        void onRemove(provider.id).catch((cause: unknown) => {
          logger.error('AI provider removal failed:', errorMessage(cause))
          // The native confirmation has closed, so the error shows as a toast.
          toastController.add({
            type: 'error',
            title: 'Could not remove the provider',
            description: errorMessage(cause),
          })
        })
      }
    },
  })

  return (
    <Drawer open={open && !nativeMenu} onOpenChange={onOpenChange}>
      <DrawerContent aria-label="Manage AI provider">
        {provider !== null && providerInfo !== null ? (
          <>
            <DrawerTitle>{title}</DrawerTitle>
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
