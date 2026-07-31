import type { AiProviderConfig } from '../settings/schema'

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
 * first entry.
 */
export function withAiProviderAdded(
  state: AiProvidersState,
  entry: AiProviderConfig,
  makeDefault: boolean,
): AiProvidersState {
  return {
    providers: [...state.providers, entry],
    defaultProviderId:
      makeDefault || state.providers.length === 0 ? entry.id : state.defaultProviderId,
  }
}

/**
 * Remove the entry with `id`. If it was the default, the first remaining
 * entry takes over (`null` when the list empties).
 */
export function withAiProviderRemoved(state: AiProvidersState, id: string): AiProvidersState {
  const providers = state.providers.filter((provider) => provider.id !== id)
  return {
    providers,
    defaultProviderId:
      state.defaultProviderId === id ? (providers[0]?.id ?? null) : state.defaultProviderId,
  }
}

/**
 * The entry AI features should use when no explicit choice is made: the one
 * `defaultProviderId` points at, falling back to the first entry when the id
 * is null or dangling.
 */
export function defaultAiProvider(state: AiProvidersState): AiProviderConfig | null {
  return (
    state.providers.find((provider) => provider.id === state.defaultProviderId) ??
    state.providers[0] ??
    null
  )
}

/**
 * Providers with a speech-to-text path, in preference order. Anthropic and
 * OpenRouter have no dedicated transcription path in this app.
 */
export const TRANSCRIPTION_PROVIDERS = ['openai', 'google'] as const

export type TranscriptionProvider = (typeof TRANSCRIPTION_PROVIDERS)[number]

/** A configured entry known to belong to a transcription-capable provider. */
export type TranscriptionConfig = AiProviderConfig & { provider: TranscriptionProvider }

/**
 * The configured entry audio transcription should run on: any OpenAI entry
 * wins over any Google entry, and within a provider the app default wins over
 * the first. `null` means no capable provider is configured — the feature is
 * unavailable. The entry only addresses the provider + API key; the
 * transcription model itself is fixed per provider (see `transcribe.ts`), so
 * the entry's default-model choice never transfers.
 */
export function pickTranscriptionConfig(state: AiProvidersState): TranscriptionConfig | null {
  for (const provider of TRANSCRIPTION_PROVIDERS) {
    const candidates = state.providers.filter(
      (candidate): candidate is TranscriptionConfig => candidate.provider === provider,
    )
    if (candidates.length > 0) {
      return (
        candidates.find((candidate) => candidate.id === state.defaultProviderId) ?? candidates[0]!
      )
    }
  }
  return null
}

/** The transcription entry a pass should use, with its keychain key. */
export interface TranscriptionTarget {
  config: TranscriptionConfig
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
 * {@link TRANSCRIPTION_PROVIDERS} order, the app-default entry first within
 * each, and the first whose keychain key resolves wins. A keyless entry is
 * skipped rather than stopping the pass — an unkeyed OpenAI entry must not
 * block a working Google one. `getKey` is the caller's (memoized) keychain
 * read, so a pass touches each entry's key at most once.
 */
export async function resolveTranscriptionTarget(
  state: AiProvidersState,
  getKey: (id: string) => Promise<string | null>,
): Promise<TranscriptionTarget | TranscriptionMiss> {
  const candidates: TranscriptionConfig[] = []
  for (const provider of TRANSCRIPTION_PROVIDERS) {
    const entries = state.providers.filter(
      (entry): entry is TranscriptionConfig => entry.provider === provider,
    )
    candidates.push(
      ...entries.filter((entry) => entry.id === state.defaultProviderId),
      ...entries.filter((entry) => entry.id !== state.defaultProviderId),
    )
  }
  if (candidates.length === 0) {
    return 'no-provider'
  }
  for (const candidate of candidates) {
    const apiKey = await getKey(candidate.id)
    if (apiKey !== null) {
      return { config: candidate, apiKey }
    }
  }
  return 'no-key'
}
