import { describe, expect, it } from 'vitest'
import type { HostedAiProviderConfig } from '../../settings/schema'
import { aiProvider } from '../provider-catalog'
import { chatModelOptions, resolveChatModel } from './model-options'

function config(overrides: Partial<HostedAiProviderConfig>): HostedAiProviderConfig {
  const provider = overrides.provider ?? 'anthropic'
  return {
    id: 'id',
    provider,
    model: aiProvider(provider).models[0]!.id,
    keyHint: 'hint1',
    ...overrides,
  }
}

describe('chatModelOptions', () => {
  it('offers every catalog model id for a configured provider', () => {
    const options = chatModelOptions([config({ id: 'a' })])
    expect(options.map((option) => option.modelId)).toEqual(
      aiProvider('anthropic').models.map((model) => model.id),
    )
    expect(options.every((option) => option.configId === 'a')).toBe(true)
  })

  it('keeps a custom configured model selectable', () => {
    const options = chatModelOptions([config({ id: 'a', model: 'custom-model' })])
    expect(options.at(-1)).toEqual({
      configId: 'a',
      provider: 'anthropic',
      modelId: 'custom-model',
      label: 'custom-model',
    })
    expect(options).toHaveLength(aiProvider('anthropic').models.length + 1)
  })

  it('keeps the configured OpenAI-compatible model selectable', () => {
    const options = chatModelOptions([
      {
        id: 'local',
        provider: 'openai-compatible',
        model: 'llama-local',
        baseUrl: 'http://localhost:1234/v1',
        keyHint: '',
      },
    ])
    expect(options.at(-1)?.modelId).toBe('llama-local')
  })

  it('groups options consecutively per configured entry', () => {
    const options = chatModelOptions([config({ id: 'a' }), config({ id: 'b', provider: 'openai' })])
    const firstOpenAi = options.findIndex((option) => option.configId === 'b')
    expect(options.slice(0, firstOpenAi).every((option) => option.configId === 'a')).toBe(true)
    expect(options.slice(firstOpenAi).every((option) => option.configId === 'b')).toBe(true)
  })

  it('returns nothing when no provider is configured', () => {
    expect(chatModelOptions([])).toEqual([])
  })
})

describe('resolveChatModel', () => {
  const entryA = config({ id: 'a' })
  const entryB = config({ id: 'b', provider: 'openai' })
  const state = { providers: [entryA, entryB], defaultProviderId: 'b' }

  it('falls back to the default entry with no selection', () => {
    expect(resolveChatModel(state, null)).toEqual(entryB)
  })

  it('applies the selected model id to the selected entry', () => {
    const modelId = aiProvider('anthropic').models.at(-1)!.id
    expect(resolveChatModel(state, { configId: 'a', modelId })).toEqual({
      ...entryA,
      model: modelId,
    })
  })

  it('falls back when the selected entry is gone', () => {
    expect(resolveChatModel(state, { configId: 'gone', modelId: 'x' })).toEqual(entryB)
  })

  it('returns null when nothing is configured', () => {
    expect(resolveChatModel({ providers: [], defaultProviderId: null }, null)).toBeNull()
  })
})
