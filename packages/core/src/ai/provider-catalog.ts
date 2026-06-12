import type { AiProviderId } from '../settings/schema'

/**
 * The static BYOK provider catalog (Plan 10): display names, key hints, and
 * the curated model list the settings UI offers per provider. This is policy
 * data, not configuration — the user's chosen entries live in settings as
 * `AiProviderConfig` values.
 */

/** One selectable model in a provider's curated list. */
export interface AiModelOption {
  /** The provider's model identifier, sent verbatim on API calls. */
  id: string
  /** Human-readable name shown in pickers. */
  label: string
}

/** One supported BYOK provider. */
export interface AiProviderInfo {
  id: AiProviderId
  /** Human-readable provider name shown in pickers. */
  label: string
  /** Placeholder illustrating the provider's API-key format. */
  keyPlaceholder: string
  /** Curated models, most capable first (the first is the picker default). */
  models: AiModelOption[]
}

export const AI_PROVIDERS: AiProviderInfo[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    keyPlaceholder: 'sk-…',
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
      { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano' },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    keyPlaceholder: 'sk-ant-…',
    models: [
      { id: 'claude-fable-5', label: 'Claude Fable 5' },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
  },
  {
    id: 'google',
    label: 'Google Gemini',
    keyPlaceholder: 'AIza…',
    models: [
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    ],
  },
]

/** The catalog entry for `id` (every `AiProviderId` is in the catalog). */
export function aiProvider(id: AiProviderId): AiProviderInfo {
  const provider = AI_PROVIDERS.find((candidate) => candidate.id === id)
  if (!provider) {
    throw new Error(`unknown AI provider: ${id}`)
  }
  return provider
}

/**
 * Display name for a model, falling back to the raw id for models outside the
 * curated list (a settings document may carry ids added by a newer version).
 */
export function aiModelLabel(provider: AiProviderId, modelId: string): string {
  const match = aiProvider(provider).models.find((model) => model.id === modelId)
  return match?.label ?? modelId
}
