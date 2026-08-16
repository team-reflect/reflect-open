import type { AiProviderId } from '../settings/schema'
import { DEFAULT_OPENAI_COMPATIBLE_MODEL } from './openai-compatible'

import type { AnthropicProvider } from '@ai-sdk/anthropic'
import type { GoogleProvider } from '@ai-sdk/google'
import type { OpenAIProvider } from '@ai-sdk/openai'


/** A compile-time guarantee that an array has at least one element. */
type NonEmptyArray<ElementType> = [ElementType, ...ElementType[]]

/** Drop the `(string & {})` escape hatch, leaving only the known literals. */
type KnownId<T> = T extends string ? (string extends T ? never : T) : never

// https://github.com/vercel/ai/blob/ai@7.0.66/packages/anthropic/src/anthropic-language-model-options.ts#L4
type AnthropicModelId = KnownId<Parameters<AnthropicProvider>[0]>
// https://github.com/vercel/ai/blob/ai@7.0.66/packages/google/src/google-language-model-options.ts#L8
type GoogleModelId = KnownId<Parameters<GoogleProvider>[0]>
// https://github.com/vercel/ai/blob/ai@7.0.66/packages/openai/src/responses/openai-responses-language-model-options.ts#L88
type OpenAIModelId = KnownId<Parameters<OpenAIProvider>[0]>

/**
 * The static BYOK provider catalog (Plan 10): display names, key hints, and
 * the curated model list the settings UI offers per provider. This is policy
 * data, not configuration — the user's chosen entries live in settings as
 * `AiProviderConfig` values.
 */

/** One selectable model in a provider's curated list. */
export interface AiModelOption<Id extends string = string> {
  /** The provider's model identifier, sent verbatim on API calls. */
  id: Id,
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
  /** Whether a non-empty key must be stored before this provider can be used. */
  apiKeyRequired: boolean
  /** Placeholder illustrating the provider's API-key format. */
  keyPlaceholder: string
  /** Curated models, most capable first (the first is the picker default). */
  models: NonEmptyArray<AiModelOption>
}

export const AI_PROVIDERS: NonEmptyArray<AiProviderInfo> = [
  {
    id: 'openai',
    label: 'OpenAI',
    apiKeyRequired: true,
    keyPlaceholder: 'sk-…',
    models: ((([
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', contextWindow: 1_000_000 },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', contextWindow: 1_000_000 },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', contextWindow: 1_000_000 },
      { id: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 1_000_000 },
      { id: 'gpt-5.4', label: 'GPT-5.4', contextWindow: 1_000_000 },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', contextWindow: 400_000 },
      { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano', contextWindow: 400_000 },
    ]) as const) satisfies  AiModelOption<OpenAIModelId>[]),
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    apiKeyRequired: true,
    keyPlaceholder: 'sk-ant-…',
    models: ((([
      { id: 'claude-fable-5', label: 'Claude Fable 5', contextWindow: 1_000_000 },
      { id: 'claude-opus-5', label: 'Claude Opus 5', contextWindow: 1_000_000 },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', contextWindow: 1_000_000 },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', contextWindow: 1_000_000 },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindow: 1_000_000 },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', contextWindow: 200_000 },
    ] as const )) satisfies  AiModelOption<AnthropicModelId>[] ),
  },
  {
    id: 'google',
    label: 'Google Gemini',
    apiKeyRequired: true,
    keyPlaceholder: 'AIza…',
    models: ((([
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', contextWindow: 1_000_000 },
      { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', contextWindow: 1_000_000 },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', contextWindow: 1_000_000 },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', contextWindow: 1_000_000 },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', contextWindow: 1_000_000 },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', contextWindow: 1_000_000 },
    ] as const)) satisfies AiModelOption<GoogleModelId>[]),
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    apiKeyRequired: true,
    keyPlaceholder: 'sk-or-v1-…',
    models: [
      { id: 'openrouter/auto', label: 'Auto Router', contextWindow: 2_000_000 },
      { id: '~openai/gpt-latest', label: 'OpenAI GPT Latest', contextWindow: 1_000_000 },
      {
        id: '~anthropic/claude-sonnet-latest',
        label: 'Claude Sonnet Latest',
        contextWindow: 1_000_000,
      },
      { id: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol', contextWindow: 1_000_000 },
    ],
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible',
    apiKeyRequired: false,
    keyPlaceholder: 'Optional API key',
    models: [{ id: DEFAULT_OPENAI_COMPATIBLE_MODEL, label: 'Local model', contextWindow: 128_000 }],
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

/** Whether a configured provider must have a non-empty keychain secret. */
export function aiProviderRequiresApiKey(id: AiProviderId): boolean {
  return aiProvider(id).apiKeyRequired
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
