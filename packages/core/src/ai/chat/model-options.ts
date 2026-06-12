import type { AiProviderConfig, AiProviderId } from '../../settings/schema'
import { aiProvider } from '../provider-catalog'
import { defaultAiProvider, type AiProvidersState } from '../provider-config'

/**
 * The chat screen's model picker (Plan 10): every configured provider offers
 * its full curated model list, not just the entry's default model. These are
 * pure derivations over the configured-provider state — the session's choice
 * itself lives in the chat provider and is never persisted.
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

/** A session's model choice — references a {@link ChatModelOption}. */
export interface ChatModelSelection {
  configId: string
  modelId: string
}

/**
 * Every model the chat picker offers, grouped consecutively per configured
 * entry: the provider's curated catalog, plus the entry's configured default
 * model when it's a custom id outside the catalog.
 */
export function chatModelOptions(providers: AiProviderConfig[]): ChatModelOption[] {
  return providers.flatMap((entry) => {
    const catalog = aiProvider(entry.provider).models
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
