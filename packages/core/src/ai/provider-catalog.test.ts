import { describe, expect, it } from 'vitest'
import { AI_PROVIDERS, DEFAULT_CONTEXT_WINDOW, modelContextWindow } from './provider-catalog'

describe('AI_PROVIDERS', () => {
  it('orders each provider’s models from most to least capable', () => {
    expect(AI_PROVIDERS.map(
      provider => ({
        id: provider.id,
        models: provider.models.map(model => model.id),
      })
    )).toEqual(
      [
        {
          "id": "openai",
          "models": [
            "gpt-6-astra",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "gpt-5.5",
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-5.4-nano",
          ],
        },
        {
          "id": "anthropic",
          "models": [
            "claude-fable-5-1",
            "claude-fable-5",
            "claude-opus-5",
            "claude-opus-4-8",
            "claude-sonnet-5",
            "claude-sonnet-4-6",
            "claude-haiku-4-5",
          ],
        },
        {
          "id": "google",
          "models": [
            "gemini-3.1-pro-preview",
            "gemini-3.8-flash",
            "gemini-3.7-flash",
            "gemini-3.6-flash",
            "gemini-3.5-flash",
            "gemini-3.5-flash-lite",
            "gemini-2.5-pro",
          ],
        },
        {
          "id": "openrouter",
          "models": [
            "openrouter/auto",
            "~openai/gpt-latest",
            "~anthropic/claude-sonnet-latest",
            "openai/gpt-5.6-sol",
          ],
        },
        {
          "id": "openai-compatible",
          "models": [
            "local-model",
          ],
        },
      ]
    )
  })
})

describe('modelContextWindow', () => {
  it('resolves catalog ids and falls back for unknown ones', () => {
    for (const provider of AI_PROVIDERS) {
      for (const model of provider.models) {
        expect(model.contextWindow).toBeGreaterThanOrEqual(100_000)
        expect(modelContextWindow(provider.id, model.id)).toBe(model.contextWindow)
      }
    }
    expect(modelContextWindow('openai', 'not-in-catalog')).toBe(DEFAULT_CONTEXT_WINDOW)
  })
})
