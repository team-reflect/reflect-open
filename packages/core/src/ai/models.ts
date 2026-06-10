import type { AiModelConfig } from '../settings/schema'

/**
 * Pure transforms over the configured-AI-models state (Plan 10). The default
 * is a single id (`defaultAiModelId` in the settings document), so "at most
 * one default" holds by construction; a dangling id resolves through
 * {@link defaultAiModel}'s first-entry fallback. Callers pair these with the
 * keychain bindings in `secrets.ts` — the state never carries the keys
 * themselves.
 */

/** The two settings-document keys these transforms operate on, together. */
export interface AiModelsState {
  models: AiModelConfig[]
  defaultModelId: string | null
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
export function withAiModelAdded(
  state: AiModelsState,
  entry: AiModelConfig,
  makeDefault: boolean,
): AiModelsState {
  return {
    models: [...state.models, entry],
    defaultModelId:
      makeDefault || state.models.length === 0 ? entry.id : state.defaultModelId,
  }
}

/**
 * Remove the entry with `id`. If it was the default, the first remaining
 * entry takes over (`null` when the list empties).
 */
export function withAiModelRemoved(state: AiModelsState, id: string): AiModelsState {
  const models = state.models.filter((model) => model.id !== id)
  return {
    models,
    defaultModelId:
      state.defaultModelId === id ? (models[0]?.id ?? null) : state.defaultModelId,
  }
}

/**
 * The entry AI features should use when no explicit choice is made: the one
 * `defaultModelId` points at, falling back to the first entry when the id is
 * null or dangling.
 */
export function defaultAiModel(state: AiModelsState): AiModelConfig | null {
  return (
    state.models.find((model) => model.id === state.defaultModelId) ?? state.models[0] ?? null
  )
}
