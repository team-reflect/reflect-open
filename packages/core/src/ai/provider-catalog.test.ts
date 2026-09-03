import { describe, expect, it } from 'vitest'
import { AI_PROVIDERS, DEFAULT_CONTEXT_WINDOW, modelContextWindow } from './provider-catalog'

describe('AI_PROVIDERS', () => {
  it('orders each provider’s models from most to least capable', () => {
    for (const { id, models } of AI_PROVIDERS) {
      const ids = models.map((model) => model.id)
      expect(ids, id).toEqual([...new Set(ids)])

      // Capability order is curated; context windows must not increase down the list.
      const windows = models.map((model) => model.contextWindow)
      expect(windows, id).toEqual([...windows].sort((a, b) => b - a))
    }
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
