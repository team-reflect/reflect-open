import { describe, expect, it } from 'vitest'
import type { AiModelConfig } from '../settings/schema'
import {
  apiKeyHint,
  defaultAiModel,
  withAiModelAdded,
  withAiModelRemoved,
  type AiModelsState,
} from './models'

function config(overrides: Partial<AiModelConfig>): AiModelConfig {
  return {
    id: 'id',
    provider: 'openai',
    model: 'gpt-5.1',
    keyHint: 'hint1',
    ...overrides,
  }
}

function state(models: AiModelConfig[], defaultModelId: string | null): AiModelsState {
  return { models, defaultModelId }
}

describe('apiKeyHint', () => {
  it('keeps only the trailing characters of a key', () => {
    expect(apiKeyHint('sk-ant-api03-secret-wxyz1')).toBe('wxyz1')
  })

  it('returns no hint for a key short enough that it would reveal most of it', () => {
    expect(apiKeyHint('abc')).toBe('')
    expect(apiKeyHint('123456789')).toBe('')
    expect(apiKeyHint('1234567890')).toBe('67890')
  })
})

describe('withAiModelAdded', () => {
  it('makes the first entry the default even when not requested', () => {
    expect(withAiModelAdded(state([], null), config({ id: 'a' }), false)).toEqual(
      state([config({ id: 'a' })], 'a'),
    )
  })

  it('appends a non-default entry without touching the default', () => {
    const before = state([config({ id: 'a' })], 'a')
    expect(withAiModelAdded(before, config({ id: 'b' }), false)).toEqual(
      state([config({ id: 'a' }), config({ id: 'b' })], 'a'),
    )
  })

  it('an entry added as default takes over', () => {
    const before = state([config({ id: 'a' })], 'a')
    expect(withAiModelAdded(before, config({ id: 'b' }), true).defaultModelId).toBe('b')
  })
})

describe('withAiModelRemoved', () => {
  it('removes the entry with the id', () => {
    const before = state([config({ id: 'a' }), config({ id: 'b' })], 'a')
    expect(withAiModelRemoved(before, 'b')).toEqual(state([config({ id: 'a' })], 'a'))
  })

  it('promotes the first remaining entry when the default is removed', () => {
    const before = state([config({ id: 'a' }), config({ id: 'b' })], 'a')
    expect(withAiModelRemoved(before, 'a')).toEqual(state([config({ id: 'b' })], 'b'))
  })

  it('removing the last entry clears the default', () => {
    expect(withAiModelRemoved(state([config({ id: 'a' })], 'a'), 'a')).toEqual(state([], null))
  })
})

describe('defaultAiModel', () => {
  it('returns the entry the id points at', () => {
    const models = [config({ id: 'a' }), config({ id: 'b' })]
    expect(defaultAiModel(state(models, 'b'))?.id).toBe('b')
  })

  it('falls back to the first entry for a null or dangling id', () => {
    const models = [config({ id: 'a' }), config({ id: 'b' })]
    expect(defaultAiModel(state(models, null))?.id).toBe('a')
    expect(defaultAiModel(state(models, 'gone'))?.id).toBe('a')
  })

  it('returns null for the empty list', () => {
    expect(defaultAiModel(state([], null))).toBeNull()
  })
})
