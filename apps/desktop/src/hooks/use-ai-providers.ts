import { useCallback } from 'react'
import {
  aiKeySecretName,
  apiKeyHint,
  defaultAiProvider,
  deleteSecret,
  setSecret,
  withAiProviderAdded,
  withAiProviderRemoved,
  type AiProviderConfig,
  type AiProviderId,
  type AppError,
} from '@reflect/core'
import { useSettings } from '@/providers/settings-provider'

/**
 * The configured-AI-providers surface (Plan 10): one hook owning the pairing
 * of the settings document (entries + default id) with the OS keychain (the
 * key itself). Components never touch the secret commands directly, so the
 * "settings entry ⇄ keychain entry" invariant has one owner.
 */

/** What the add-provider dialog collects; the key goes to the keychain only. */
export interface NewAiProvider {
  provider: AiProviderId
  model: string
  apiKey: string
  isDefault: boolean
}

interface UseAiProvidersValue {
  providers: AiProviderConfig[]
  /** The entry AI features use by default (null only when the list is empty). */
  defaultProvider: AiProviderConfig | null
  /**
   * Store the key in the keychain, then add the settings entry. Rejects (and
   * adds nothing) if the keychain write fails — so an entry can never point
   * at a key that was never stored — or if the settings store could not be
   * read this session, so a key can never be stored for an entry that won't
   * survive a restart.
   */
  addProvider: (draft: NewAiProvider) => Promise<void>
  /** Delete the key from the keychain, then drop the settings entry. */
  removeProvider: (id: string) => Promise<void>
  /** Make the entry with `id` the app-wide default. */
  makeDefault: (id: string) => void
  /** Change the default model used by the configured provider entry. */
  setDefaultModel: (id: string, model: string) => void
}

export function useAiProviders(): UseAiProvidersValue {
  const { settings, updateSettingsWith, whenSettingsLoaded } = useSettings()
  const providers = settings.aiProviders
  const defaultProvider = defaultAiProvider({
    providers,
    defaultProviderId: settings.defaultAiProviderId,
  })

  // Every write goes through `updateSettingsWith` so the state is rebuilt
  // from the settings as they are when the update applies — not from this
  // render's snapshot. The keychain awaits make these genuinely concurrent:
  // a second add/remove can land mid-flight, and a snapshot-based write
  // would clobber it (or resurrect an entry whose key was already deleted).

  const addProvider = useCallback(
    async (draft: NewAiProvider): Promise<void> => {
      // Refuse before the key touches the keychain: with an unreadable
      // settings store the entry would be session-only, and after a restart
      // the stored key would be orphaned with no UI left to delete it.
      // Awaiting the outcome (rather than reading a flag) also covers an add
      // racing the in-flight load that then fails.
      if ((await whenSettingsLoaded()) === 'failed') {
        const error: AppError = {
          kind: 'io',
          message:
            'Settings could not be loaded, so new AI providers cannot be saved. The API key was not stored.',
        }
        throw error
      }
      const id = crypto.randomUUID()
      await setSecret(aiKeySecretName(id), draft.apiKey)
      updateSettingsWith((current) => {
        const next = withAiProviderAdded(
          { providers: current.aiProviders, defaultProviderId: current.defaultAiProviderId },
          { id, provider: draft.provider, model: draft.model, keyHint: apiKeyHint(draft.apiKey) },
          draft.isDefault,
        )
        return { aiProviders: next.providers, defaultAiProviderId: next.defaultProviderId }
      })
    },
    [whenSettingsLoaded, updateSettingsWith],
  )

  const removeProvider = useCallback(
    async (id: string): Promise<void> => {
      // Keychain first, deliberately. The two stores can't be updated
      // transactionally; interrupted in this order, the leftover is a
      // visibly dead settings row the user can remove again. The reverse
      // order would strand the credential invisibly in the keychain — the
      // keyring API can't enumerate entries, so it could never be swept.
      // The settings write itself is retried by the provider on failure.
      await deleteSecret(aiKeySecretName(id))
      updateSettingsWith((current) => {
        const next = withAiProviderRemoved(
          { providers: current.aiProviders, defaultProviderId: current.defaultAiProviderId },
          id,
        )
        return { aiProviders: next.providers, defaultAiProviderId: next.defaultProviderId }
      })
    },
    [updateSettingsWith],
  )

  const makeDefault = useCallback(
    (id: string): void => {
      updateSettingsWith(() => ({ defaultAiProviderId: id }))
    },
    [updateSettingsWith],
  )

  const setDefaultModel = useCallback(
    (id: string, model: string): void => {
      const normalizedModel = model.trim()
      if (normalizedModel === '') {
        return
      }
      updateSettingsWith((current) => ({
        aiProviders: current.aiProviders.map((provider) =>
          provider.id === id ? { ...provider, model: normalizedModel } : provider,
        ),
      }))
    },
    [updateSettingsWith],
  )

  return {
    providers,
    defaultProvider,
    addProvider,
    removeProvider,
    makeDefault,
    setDefaultModel,
  }
}
