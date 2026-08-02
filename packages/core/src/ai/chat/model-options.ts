import type { AiProviderConfig, AiProviderId, ChatModelSelection } from '../../settings/schema'
import { aiProvider, aiProviderSupportsChat } from '../provider-catalog'
import { defaultAiProvider, type AiProvidersState } from '../provider-config'
import { DISABLED_OPENAI_COMPATIBLE_MODEL } from '../openai-compatible'

/**
 * The chat screen's model picker (Plan 10): every configured provider offers
 * its full curated model list, not just the entry's default model. These are
 * pure derivations over the configured-provider state — the choice itself is
 * the `chatModelSelection` settings key, persisted so the next session starts
 * on the model the user picked last.
 */

/** One pick in the chat model picker: a configured provider entry + model. */
export interface ChatModelOption {
  /** The configured entry (`AiProviderConfig.id`) supplying the API key. */
  configId: string
  provider: AiProviderId
  /** The model identifier, sent verbatim on API calls. */
  modelId: string
  /** Display name (catalog label, or the raw id for custom models). */
  label: string
}

export type { ChatModelSelection }

/**
 * Every model the chat picker offers, grouped consecutively per configured
 * entry: the provider's curated catalog, plus the entry's configured default
 * model when it's a custom id outside the catalog.  Entries whose chat model
 * is the `'disabled'` sentinel offer nothing - the picker cannot switch to
 * them.  The `'disabled'` sentinel (an OpenAI-compatible catalog option that
 * opts an entry out of chat) is itself never offered as a pickable model.
 */
export function chatModelOptions(providers: AiProviderConfig[]): ChatModelOption[] {
  return providers
    .filter((entry) => aiProviderSupportsChat(entry))
    .flatMap((entry) => {
      const catalog = aiProvider(entry.provider).models.filter(
        (model) => model.id !== DISABLED_OPENAI_COMPATIBLE_MODEL,
      )
      const models = catalog.some((model) => model.id === entry.model)
        ? catalog
        : [...catalog, { id: entry.model, label: entry.model }]
      return models.map((model) => ({
        configId: entry.id,
        provider: entry.provider,
        modelId: model.id,
        label: model.label,
      }))
    })
}

/**
 * The provider entry a chat turn should call, with `selection`'s model
 * applied. A null or dangling selection (the entry was removed) falls back to
 * the app default entry and its configured default model.
 */
export function resolveChatModel(
  state: AiProvidersState,
  selection: ChatModelSelection | null,
): AiProviderConfig | null {
  if (selection !== null) {
    const entry = state.providers.find((provider) => provider.id === selection.configId)
    if (entry !== undefined) {
      return { ...entry, model: selection.modelId }
    }
  }
  return defaultAiProvider(state)
}
