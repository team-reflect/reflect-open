import { describe, expect, it } from 'vitest'
import type { AiProviderConfig } from '../settings/schema'
import {
  AI_PROVIDERS,
  DEFAULT_CONTEXT_WINDOW,
  aiProvider,
  aiProviderSupportsChat,
  aiProviderSupportsTranscription,
  modelContextWindow,
} from './provider-catalog'

describe('AI_PROVIDERS', () => {
  it('offers the current Claude lineup in capability order', () => {
    expect(aiProvider('anthropic').models.slice(0, 3)).toEqual([
      { id: 'claude-fable-5', label: 'Claude Fable 5', contextWindow: 1_000_000 },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', contextWindow: 1_000_000 },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', contextWindow: 1_000_000 },
    ])
  })

  it('offers the GPT-5.6 family in capability order', () => {
    expect(aiProvider('openai').models.slice(0, 3)).toEqual([
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', contextWindow: 1_000_000 },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', contextWindow: 1_000_000 },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', contextWindow: 1_000_000 },
    ])
  })

  it('includes OpenRouter in the settings catalog', () => {
    expect(aiProvider('openrouter')).toMatchObject({
      id: 'openrouter',
      label: 'OpenRouter',
      keyPlaceholder: 'sk-or-v1-…',
    })
  })

  it('includes OpenAI-compatible endpoints with optional keys', () => {
    expect(aiProvider('openai-compatible')).toMatchObject({
      id: 'openai-compatible',
      label: 'OpenAI-compatible',
      apiKeyRequired: false,
      keyPlaceholder: 'Optional API key',
    })
  })

  it('offers local-model (first) and disabled for OpenAI-compatible entries', () => {
    expect(aiProvider('openai-compatible').models.map((model) => model.id)).toEqual([
      'local-model',
      'disabled',
    ])
  })
})

describe('aiProviderSupportsChat', () => {
  const openaiCompatible = (model: string): AiProviderConfig => ({
    id: 'local',
    provider: 'openai-compatible',
    model,
    keyHint: '',
    baseUrl: 'http://localhost:1234/v1',
    transcriptionModel: '',
  })

  it('is always true for hosted providers', () => {
    const hosted: AiProviderConfig = {
      id: 'oai',
      provider: 'openai',
      model: 'gpt-5.4',
      keyHint: '',
    }
    expect(aiProviderSupportsChat(hosted)).toBe(true)
  })

  it('is true for a real model and false for the disabled sentinel', () => {
    expect(aiProviderSupportsChat(openaiCompatible('local-model'))).toBe(true)
    expect(aiProviderSupportsChat(openaiCompatible('llama-local'))).toBe(true)
    expect(aiProviderSupportsChat(openaiCompatible('disabled'))).toBe(false)
  })
})

describe('aiProviderSupportsTranscription', () => {
  const openaiCompatible = (transcriptionModel: string): AiProviderConfig => ({
    id: 'local',
    provider: 'openai-compatible',
    model: 'local-model',
    keyHint: '',
    baseUrl: 'http://localhost:1234/v1',
    transcriptionModel,
  })

  it('follows the catalog constant for hosted providers', () => {
    const openai: AiProviderConfig = {
      id: 'oai',
      provider: 'openai',
      model: 'gpt-5.4',
      keyHint: '',
    }
    const anthropic: AiProviderConfig = {
      id: 'claude',
      provider: 'anthropic',
      model: 'claude-fable-5',
      keyHint: '',
    }
    expect(aiProviderSupportsTranscription(openai)).toBe(true)
    expect(aiProviderSupportsTranscription(anthropic)).toBe(false)
  })

  it('is false for the legacy unset value and the disabled sentinel', () => {
    expect(aiProviderSupportsTranscription(openaiCompatible(''))).toBe(false)
    expect(aiProviderSupportsTranscription(openaiCompatible('disabled'))).toBe(false)
  })

  it('is true for a real transcription model', () => {
    expect(aiProviderSupportsTranscription(openaiCompatible('whisper-large-v3'))).toBe(true)
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
