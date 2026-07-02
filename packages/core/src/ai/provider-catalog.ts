import type { AiProviderId } from '../settings/schema'

/** A compile-time guarantee that an array has at least one element. */
type NonEmptyArray<ElementType> = [ElementType, ...ElementType[]]

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
  /**
   * The model's context window in tokens — a deliberate floor, not a spec
   * sheet: the chat engine only needs a budget that never exceeds the real
   * window (`ai/chat/context-window`), so undershooting is safe and exact
   * vendor numbers don't matter.
   */
  contextWindow: number
}

/** One supported BYOK provider. */
export interface AiProviderInfo {
  id: AiProviderId
  /** Human-readable provider name shown in pickers. */
  label: string
  /** Placeholder illustrating the provider's API-key format. */
  keyPlaceholder: string
  /** Curated models, most capable first (the first is the picker default). */
  models: NonEmptyArray<AiModelOption>
}

export const AI_PROVIDERS: NonEmptyArray<AiProviderInfo> = [
  {
    id: 'openai',
    label: 'OpenAI',
    keyPlaceholder: 'sk-…',
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 1_000_000 },
      { id: 'gpt-5.4', label: 'GPT-5.4', contextWindow: 1_000_000 },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', contextWindow: 400_000 },
      { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano', contextWindow: 400_000 },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    keyPlaceholder: 'sk-ant-…',
    models: [
      { id: 'claude-fable-5', label: 'Claude Fable 5', contextWindow: 1_000_000 },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', contextWindow: 1_000_000 },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindow: 1_000_000 },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', contextWindow: 200_000 },
    ],
  },
  {
    id: 'google',
    label: 'Google Gemini',
    keyPlaceholder: 'AIza…',
    models: [
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', contextWindow: 1_000_000 },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', contextWindow: 1_000_000 },
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', contextWindow: 1_000_000 },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', contextWindow: 1_000_000 },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    keyPlaceholder: 'sk-or-v1-…',
    models: [
      { id: 'openrouter/auto', label: 'Auto Router', contextWindow: 128_000 },
      { id: '~openai/gpt-latest', label: 'OpenAI GPT Latest', contextWindow: 128_000 },
      {
        id: '~anthropic/claude-sonnet-latest',
        label: 'Claude Sonnet Latest',
        contextWindow: 128_000,
      },
      { id: 'openai/gpt-5.2', label: 'GPT-5.2', contextWindow: 400_000 },
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

/**
 * Floor for models outside the curated list (a settings document may carry
 * ids added by a newer version): small enough to be safe on any model worth
 * configuring, large enough not to cripple the history.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/**
 * Context window (in tokens) for a model, falling back to
 * {@link DEFAULT_CONTEXT_WINDOW} for ids outside the curated list.
 */
export function modelContextWindow(provider: AiProviderId, modelId: string): number {
  const match = aiProvider(provider).models.find((model) => model.id === modelId)
  return match?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
}
