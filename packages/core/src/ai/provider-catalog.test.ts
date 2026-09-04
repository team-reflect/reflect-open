import { describe, expect, it } from 'vitest'
import { AI_PROVIDERS, DEFAULT_CONTEXT_WINDOW, modelContextWindow } from './provider-catalog'

describe('AI_PROVIDERS', () => {
  it('orders each provider’s models from most to least capable', () => {
    expect(AI_PROVIDERS.map(
      provider => ({
        id: provider.id,
        models: provider.models.map(model => model.id),
      })
    )).toMatchInlineSnapshot()
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
