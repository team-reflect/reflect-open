import { describe, expect, it } from 'vitest'
import type { AiProviderConfig } from '../settings/schema'
import {
  apiKeyHint,
  defaultAiProvider,
  pickTranscriptionConfig,
  withAiProviderAdded,
  withAiProviderRemoved,
  type AiProvidersState,
} from './provider-config'

function config(overrides: Partial<AiProviderConfig>): AiProviderConfig {
  return {
    id: 'id',
    provider: 'openai',
    model: 'gpt-5.1',
    keyHint: 'hint1',
    ...overrides,
  }
}

function state(providers: AiProviderConfig[], defaultProviderId: string | null): AiProvidersState {
  return { providers, defaultProviderId }
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

describe('withAiProviderAdded', () => {
  it('makes the first entry the default even when not requested', () => {
    expect(withAiProviderAdded(state([], null), config({ id: 'a' }), false)).toEqual(
      state([config({ id: 'a' })], 'a'),
    )
  })

  it('appends a non-default entry without touching the default', () => {
    const before = state([config({ id: 'a' })], 'a')
    expect(withAiProviderAdded(before, config({ id: 'b' }), false)).toEqual(
      state([config({ id: 'a' }), config({ id: 'b' })], 'a'),
    )
  })

  it('an entry added as default takes over', () => {
    const before = state([config({ id: 'a' })], 'a')
    expect(withAiProviderAdded(before, config({ id: 'b' }), true).defaultProviderId).toBe('b')
  })
})

describe('withAiProviderRemoved', () => {
  it('removes the entry with the id', () => {
    const before = state([config({ id: 'a' }), config({ id: 'b' })], 'a')
    expect(withAiProviderRemoved(before, 'b')).toEqual(state([config({ id: 'a' })], 'a'))
  })

  it('promotes the first remaining entry when the default is removed', () => {
    const before = state([config({ id: 'a' }), config({ id: 'b' })], 'a')
    expect(withAiProviderRemoved(before, 'a')).toEqual(state([config({ id: 'b' })], 'b'))
  })

  it('removing the last entry clears the default', () => {
    expect(withAiProviderRemoved(state([config({ id: 'a' })], 'a'), 'a')).toEqual(state([], null))
  })
})

describe('pickTranscriptionConfig', () => {
  it('prefers any openai entry over a google default', () => {
    const providers = [
      config({ id: 'gemini', provider: 'google', model: 'gemini-2.5-flash' }),
      config({ id: 'oai', provider: 'openai' }),
    ]
    expect(pickTranscriptionConfig(state(providers, 'gemini'))?.id).toBe('oai')
  })

  it('prefers the app default among entries of the chosen provider', () => {
    const providers = [config({ id: 'first' }), config({ id: 'second' })]
    expect(pickTranscriptionConfig(state(providers, 'second'))?.id).toBe('second')
  })

  it('falls back to google when no openai entry exists', () => {
    const providers = [
      config({ id: 'claude', provider: 'anthropic', model: 'claude-fable-5' }),
      config({ id: 'gemini', provider: 'google', model: 'gemini-2.5-flash' }),
    ]
    expect(pickTranscriptionConfig(state(providers, 'claude'))?.id).toBe('gemini')
  })

  it('returns null when only non-transcription providers exist', () => {
    const providers = [
      config({ id: 'claude', provider: 'anthropic', model: 'claude-fable-5' }),
      config({ id: 'openrouter', provider: 'openrouter', model: 'openrouter/auto' }),
    ]
    expect(pickTranscriptionConfig(state(providers, 'claude'))).toBeNull()
  })

  it('returns null for the empty list', () => {
    expect(pickTranscriptionConfig(state([], null))).toBeNull()
  })
})

describe('defaultAiProvider', () => {
  it('returns the entry the id points at', () => {
    const providers = [config({ id: 'a' }), config({ id: 'b' })]
    expect(defaultAiProvider(state(providers, 'b'))?.id).toBe('b')
  })

  it('falls back to the first entry for a null or dangling id', () => {
    const providers = [config({ id: 'a' }), config({ id: 'b' })]
    expect(defaultAiProvider(state(providers, null))?.id).toBe('a')
    expect(defaultAiProvider(state(providers, 'gone'))?.id).toBe('a')
  })

  it('returns null for the empty list', () => {
    expect(defaultAiProvider(state([], null))).toBeNull()
  })
})
