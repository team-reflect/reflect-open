import { describe, expect, it } from 'vitest'
import {
  AI_PROVIDERS,
  DEFAULT_CONTEXT_WINDOW,
  aiProvider,
  modelContextWindow,
} from './provider-catalog'

describe('AI_PROVIDERS', () => {
  it('includes OpenRouter in the settings catalog', () => {
    expect(aiProvider('openrouter')).toMatchObject({
      id: 'openrouter',
      label: 'OpenRouter',
      keyPlaceholder: 'sk-or-v1-…',
    })
  })
})

describe('modelContextWindow', () => {
  it('every curated model declares a usable context window', () => {
    for (const provider of AI_PROVIDERS) {
      for (const model of provider.models) {
        // The chat engine's budget math needs real headroom beyond the
        // 60k-token turn reserve — a window this small would be a typo.
        expect(model.contextWindow, `${provider.id}/${model.id}`).toBeGreaterThanOrEqual(100_000)
      }
    }
  })

  it('resolves a curated model and falls back for unknown ids', () => {
    expect(modelContextWindow('anthropic', 'claude-haiku-4-5')).toBe(200_000)
    expect(modelContextWindow('openrouter', 'openrouter/auto')).toBe(128_000)
    // Settings may carry ids added by a newer app version.
    expect(modelContextWindow('anthropic', 'claude-fable-6')).toBe(DEFAULT_CONTEXT_WINDOW)
  })
})
