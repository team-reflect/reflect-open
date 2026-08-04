import type { AiProviderConfig } from '../settings/schema'
import { aiProviderSupportsChat, aiProviderSupportsTranscription } from './provider-catalog'

/**
 * Pure transforms over the configured-AI-provider state (Plan 10). The
 * default is a single id (`defaultAiProviderId` in the settings document), so
 * "at most one default" holds by construction; a dangling id resolves through
 * {@link defaultAiProvider}'s first-entry fallback. Callers pair these with
 * the keychain bindings in `secrets.ts` — the state never carries the keys
 * themselves.
 */

/** The two settings-document keys these transforms operate on, together. */
export interface AiProvidersState {
  providers: AiProviderConfig[]
  defaultProviderId: string | null
  defaultTranscriptionProviderId: string | null
}

/** How many trailing key characters are kept as the display hint. */
export const KEY_HINT_LENGTH = 5

/**
 * The display-only suffix of an API key (`keyHint` in the settings doc).
 * Empty for keys shorter than twice the hint — a hint must never reveal
 * most of the key it identifies.
 */
export function apiKeyHint(key: string): string {
  return key.length >= KEY_HINT_LENGTH * 2 ? key.slice(-KEY_HINT_LENGTH) : ''
}

/**
 * Append `entry`; it becomes the default when requested or when it is the
 * first entry.  The transcription default follows the same rule for
 * transcription-capable entries.
 */
export function withAiProviderAdded(
  state: AiProvidersState,
  entry: AiProviderConfig,
  isDefault: boolean,
  isTranscriptionDefault?: boolean,
): AiProvidersState {
  const isFirst = state.providers.length === 0
  const makeTranscriptionDefault =
    isTranscriptionDefault ?? (isDefault && aiProviderSupportsTranscription(entry))
  return {
    providers: [...state.providers, entry],
    defaultProviderId: isDefault || isFirst ? entry.id : state.defaultProviderId,
    defaultTranscriptionProviderId:
      makeTranscriptionDefault || (isFirst && aiProviderSupportsTranscription(entry))
        ? entry.id
        : state.defaultTranscriptionProviderId,
  }
}

/**
 * Remove the entry with `id`. If it was the default, the first remaining
 * entry takes over (`null` when the list empties).  The transcription
 * default likewise promotes the first remaining transcription-capable
 * entry, or `null` when none remain.
 */
export function withAiProviderRemoved(state: AiProvidersState, id: string): AiProvidersState {
  const providers = state.providers.filter((provider) => provider.id !== id)
  const firstTranscription = providers.find((provider) => aiProviderSupportsTranscription(provider))
  return {
    providers,
    defaultProviderId:
      state.defaultProviderId === id ? (providers[0]?.id ?? null) : state.defaultProviderId,
    defaultTranscriptionProviderId:
      state.defaultTranscriptionProviderId === id
        ? (firstTranscription?.id ?? null)
        : state.defaultTranscriptionProviderId,
  }
}

/**
 * The entry AI features should use when no explicit choice is made: the one
 * `defaultProviderId` points at, falling back to the first entry when the id
 * is null or dangling.  Entries whose chat model is the `'disabled'`
 * sentinel are skipped in both passes — when nothing chat-capable exists
 * the id-targeted entry still wins over returning nothing, so the stored
 * default never silently dies.
 */
export function defaultAiProvider(state: AiProvidersState): AiProviderConfig | null {
  const targeted = state.providers.find((provider) => provider.id === state.defaultProviderId)
  if (targeted !== undefined && aiProviderSupportsChat(targeted)) {
    return targeted
  }
  return (
    state.providers.find((provider) => aiProviderSupportsChat(provider)) ??
    targeted ??
    state.providers[0] ??
    null
  )
}

/**
 * The entry transcription should use when no explicit choice is made: the
 * one `defaultTranscriptionProviderId` points at, falling back to the first
 * transcription-capable entry, or `null` when none are configured.
 */
export function defaultTranscriptionProvider(state: AiProvidersState): AiProviderConfig | null {
  const preferred =
    state.defaultTranscriptionProviderId !== null
      ? state.providers.find(
          (provider) =>
            provider.id === state.defaultTranscriptionProviderId &&
            aiProviderSupportsTranscription(provider),
        )
      : undefined
  return (
    preferred ??
    state.providers.find((provider) => aiProviderSupportsTranscription(provider)) ??
    null
  )
}

/**
 * Every configured provider that supports transcription, in preference
 * order: OpenAI entries first, then Google, then any `openai-compatible`
 * entry whose `transcriptionModel` is a real model (not the legacy unset
 * `''` or the `'disabled'` sentinel).  Within each provider group
 * the app default wins over the first entry; for transcription the
 * dedicated `defaultTranscriptionProviderId` is used instead of the chat
 * default.
 */
export function transcriptionProviders(state: AiProvidersState): AiProviderConfig[] {
  const candidates = state.providers.filter((provider) => aiProviderSupportsTranscription(provider))
  // Stable sort: OpenAI > Google > openai-compatible, default-first within each group.
  const groupOrder = (provider: string): number => {
    if (provider === 'openai') return 0
    if (provider === 'google') return 1
    return 2 // openai-compatible
  }
  return candidates.sort((left, right) => {
    const groupDiff = groupOrder(left.provider) - groupOrder(right.provider)
    if (groupDiff !== 0) return groupDiff
    const leftDefault = left.id === state.defaultTranscriptionProviderId ? 0 : 1
    const rightDefault = right.id === state.defaultTranscriptionProviderId ? 0 : 1
    return leftDefault - rightDefault
  })
}

/**
 * The configured entry audio transcription should run on: the first
 * transcription-capable provider, in {@link transcriptionProviders} order.
 * `null` means no capable provider is configured - the feature is
 * unavailable.
 */
export function pickTranscriptionConfig(state: AiProvidersState): AiProviderConfig | null {
  const candidates = transcriptionProviders(state)
  return candidates[0] ?? null
}

/**
 * Providers that can serve transcription requests.  `openai` and `google`
 * are known at compile-time; `openai-compatible` entries become eligible
 * when the user supplies a real `transcriptionModel` (`''` and `'disabled'`
 * both stay ineligible).  The type is
 * intentionally narrower than {@link AiProviderId} — Anthropic and
 * OpenRouter have no transcription path and should never reach
 * {@link transcribeAudio}.
 */
export type TranscriptionProvider = 'openai' | 'google' | 'openai-compatible'

/**
 * The ordered list of provider identifiers that support transcription,
 * from highest to lowest priority. Used by consent UI to know which
 * providers send audio data and by {@link resolveTranscriptionTarget}
 * to order candidates.
 */
export const TRANSCRIPTION_PROVIDERS: readonly TranscriptionProvider[] = [
  'openai',
  'google',
  'openai-compatible',
]

/**
 * Type guard: is `provider` one of the identifiers that supports
 * transcription? Narrows the union for call sites that must branch on the
 * concrete provider (e.g. {@link transcribeAudio}).
 */
export function isTranscriptionProvider(provider: string): provider is TranscriptionProvider {
  return (TRANSCRIPTION_PROVIDERS as readonly string[]).includes(provider)
}

/** The transcription entry a pass should use, with its keychain key. */
export interface TranscriptionTarget {
  config: AiProviderConfig
  apiKey: string
}

/** Why no target resolved: nothing configured, or nothing with a key. */
export type TranscriptionMiss = 'no-provider' | 'no-key'

/**
 * Size guard for one recording segment, applied before any bytes are read.
 * Rotation-sized segments run a few megabytes, far under every provider's
 * request ceiling — this guards against encoder surprises (an ignored
 * bitrate hint), and tripping it skips the segment, never tombstones it.
 */
export const TRANSCRIPTION_MAX_SEGMENT_BYTES = 24 * 1024 * 1024

/**
 * The entry audio transcription should run on: providers in
 * {@link transcriptionProviders} order, the transcription-default entry
 * first within each provider group, and the first whose keychain key
 * resolves wins. A keyless entry is skipped rather than stopping the pass
 * — an unkeyed OpenAI entry must not block a working Google one. `getKey`
 * is the caller's (memoized) keychain read, so a pass touches each entry's
 * key at most once.
 */
export async function resolveTranscriptionTarget(
  state: AiProvidersState,
  getKey: (config: AiProviderConfig) => Promise<string | null>,
): Promise<TranscriptionTarget | TranscriptionMiss> {
  const candidates = transcriptionProviders(state)
  if (candidates.length === 0) {
    return 'no-provider'
  }
  for (const candidate of candidates) {
    const apiKey = await getKey(candidate)
    if (apiKey !== null) {
      return { config: candidate, apiKey }
    }
  }
  return 'no-key'
}
