import { useCallback } from 'react'
import {
  aiKeySecretName,
  apiKeyHint,
  defaultAiModel,
  deleteSecret,
  setSecret,
  withAiModelAdded,
  withAiModelRemoved,
  type AiModelConfig,
  type AiProviderId,
  type AppError,
} from '@reflect/core'
import { useSettings } from '@/providers/settings-provider'

/**
 * The configured-AI-models surface (Plan 10): one hook owning the pairing of
 * the settings document (entries + default id) with the OS keychain (the key
 * itself). Components never touch the secret commands directly, so the
 * "settings entry ⇄ keychain entry" invariant has one owner.
 */

/** What the add-model dialog collects; the key goes to the keychain only. */
export interface NewAiModel {
  provider: AiProviderId
  model: string
  apiKey: string
  isDefault: boolean
}

interface UseAiModelsValue {
  models: AiModelConfig[]
  /** The entry AI features use by default (null only when the list is empty). */
  defaultModel: AiModelConfig | null
  /**
   * Store the key in the keychain, then add the settings entry. Rejects (and
   * adds nothing) if the keychain write fails — so an entry can never point
   * at a key that was never stored — or if the settings store could not be
   * read this session, so a key can never be stored for an entry that won't
   * survive a restart.
   */
  addModel: (draft: NewAiModel) => Promise<void>
  /** Delete the key from the keychain, then drop the settings entry. */
  removeModel: (id: string) => Promise<void>
  /** Make the entry with `id` the app-wide default. */
  makeDefault: (id: string) => void
}

export function useAiModels(): UseAiModelsValue {
  const { settings, updateSettingsWith, whenSettingsLoaded } = useSettings()
  const models = settings.aiModels
  const defaultModel = defaultAiModel({ models, defaultModelId: settings.defaultAiModelId })

  // Every write goes through `updateSettingsWith` so the state is rebuilt
  // from the settings as they are when the update applies — not from this
  // render's snapshot. The keychain awaits make these genuinely concurrent:
  // a second add/remove can land mid-flight, and a snapshot-based write
  // would clobber it (or resurrect an entry whose key was already deleted).

  const addModel = useCallback(
    async (draft: NewAiModel): Promise<void> => {
      // Refuse before the key touches the keychain: with an unreadable
      // settings store the entry would be session-only, and after a restart
      // the stored key would be orphaned with no UI left to delete it.
      // Awaiting the outcome (rather than reading a flag) also covers an add
      // racing the in-flight load that then fails.
      if ((await whenSettingsLoaded()) === 'failed') {
        const error: AppError = {
          kind: 'io',
          message:
            'Settings could not be loaded, so new AI models cannot be saved. The API key was not stored.',
        }
        throw error
      }
      const id = crypto.randomUUID()
      await setSecret(aiKeySecretName(id), draft.apiKey)
      updateSettingsWith((current) => {
        const next = withAiModelAdded(
          { models: current.aiModels, defaultModelId: current.defaultAiModelId },
          { id, provider: draft.provider, model: draft.model, keyHint: apiKeyHint(draft.apiKey) },
          draft.isDefault,
        )
        return { aiModels: next.models, defaultAiModelId: next.defaultModelId }
      })
    },
    [whenSettingsLoaded, updateSettingsWith],
  )

  const removeModel = useCallback(
    async (id: string): Promise<void> => {
      // Keychain first, deliberately. The two stores can't be updated
      // transactionally; interrupted in this order, the leftover is a
      // visibly dead settings row the user can remove again. The reverse
      // order would strand the credential invisibly in the keychain — the
      // keyring API can't enumerate entries, so it could never be swept.
      // The settings write itself is retried by the provider on failure.
      await deleteSecret(aiKeySecretName(id))
      updateSettingsWith((current) => {
        const next = withAiModelRemoved(
          { models: current.aiModels, defaultModelId: current.defaultAiModelId },
          id,
        )
        return { aiModels: next.models, defaultAiModelId: next.defaultModelId }
      })
    },
    [updateSettingsWith],
  )

  const makeDefault = useCallback(
    (id: string): void => {
      updateSettingsWith(() => ({ defaultAiModelId: id }))
    },
    [updateSettingsWith],
  )

  return { models, defaultModel, addModel, removeModel, makeDefault }
}
