import { describe, expect, it } from 'vitest'
import type { AiProviderConfig } from '../../settings/schema'
import { aiProvider } from '../provider-catalog'
import { chatModelOptions, resolveChatModel } from './model-options'

function config(overrides: Partial<AiProviderConfig>): AiProviderConfig {
  return {
    id: 'id',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    keyHint: 'hint1',
    ...overrides,
  }
}

describe('chatModelOptions', () => {
  it('offers every catalog model of a configured provider', () => {
    const options = chatModelOptions([config({ id: 'a' })])
    expect(options.map((option) => option.modelId)).toEqual(
      aiProvider('anthropic').models.map((model) => model.id),
    )
    expect(options.every((option) => option.configId === 'a')).toBe(true)
    expect(options.find((option) => option.modelId === 'claude-fable-5')?.label).toBe(
      'Claude Fable 5',
    )
  })

  it('keeps a custom configured model selectable, labeled by its raw id', () => {
    const options = chatModelOptions([config({ id: 'a', model: 'claude-custom' })])
    const custom = options.at(-1)
    expect(custom).toEqual({
      configId: 'a',
      provider: 'anthropic',
      modelId: 'claude-custom',
      label: 'claude-custom',
    })
    expect(options).toHaveLength(aiProvider('anthropic').models.length + 1)
  })

  it('groups options consecutively per configured entry', () => {
    const options = chatModelOptions([
      config({ id: 'a' }),
      config({ id: 'b', provider: 'openai', model: 'gpt-5.5' }),
    ])
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
  const entryB = config({ id: 'b', provider: 'openai', model: 'gpt-5.5' })
  const state = { providers: [entryA, entryB], defaultProviderId: 'b' }

  it('falls back to the default entry and its configured model with no selection', () => {
    expect(resolveChatModel(state, null)).toEqual(entryB)
  })

  it('applies the selected model to the selected entry', () => {
    expect(resolveChatModel(state, { configId: 'a', modelId: 'claude-haiku-4-5' })).toEqual({
      ...entryA,
      model: 'claude-haiku-4-5',
    })
  })

  it('a selection whose entry was removed falls back to the default', () => {
    expect(resolveChatModel(state, { configId: 'gone', modelId: 'gpt-5.4' })).toEqual(entryB)
  })

  it('returns null when nothing is configured', () => {
    expect(resolveChatModel({ providers: [], defaultProviderId: null }, null)).toBeNull()
  })
})
