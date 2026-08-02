import { describe, expect, it, vi } from 'vitest'
import type {
  AiProviderConfig,
  HostedAiProviderConfig,
  OpenAiCompatibleProviderConfig,
} from '../settings/schema'
import {
  apiKeyHint,
  defaultAiProvider,
  defaultTranscriptionProvider,
  pickTranscriptionConfig,
  resolveTranscriptionTarget,
  transcriptionProviders,
  withAiProviderAdded,
  withAiProviderRemoved,
  type AiProvidersState,
} from './provider-config'

function config(overrides: Partial<HostedAiProviderConfig>): HostedAiProviderConfig {
  return {
    id: 'id',
    provider: 'openai',
    model: 'gpt-5.1',
    keyHint: 'hint1',
    ...overrides,
  }
}

function compatible(
  overrides: Partial<OpenAiCompatibleProviderConfig>,
): OpenAiCompatibleProviderConfig {
  return {
    id: 'compat',
    provider: 'openai-compatible',
    model: 'local-model',
    keyHint: '',
    baseUrl: 'http://localhost:1234/v1',
    transcriptionModel: '',
    ...overrides,
  }
}

function state(
  providers: AiProviderConfig[],
  defaultProviderId: string | null,
  defaultTranscriptionProviderId?: string | null,
): AiProvidersState {
  return {
    providers,
    defaultProviderId,
    defaultTranscriptionProviderId: defaultTranscriptionProviderId ?? null,
  }
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
    expect(withAiProviderAdded(state([], null), config({ id: 'a' }), false)).toEqual({
      providers: [config({ id: 'a' })],
      defaultProviderId: 'a',
      defaultTranscriptionProviderId: 'a', // OpenAI is transcription-capable
    })
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

  it('does not set a non-transcription-capable first entry as transcription default', () => {
    const result = withAiProviderAdded(
      state([], null),
      config({ id: 'claude', provider: 'anthropic', model: 'claude-fable-5' }),
      false,
    )
    expect(result.defaultProviderId).toBe('claude')
    expect(result.defaultTranscriptionProviderId).toBeNull()
  })

  it('a transcription-capable entry added as default sets both defaults', () => {
    const before = state([config({ id: 'a' })], 'a')
    const result = withAiProviderAdded(
      before,
      compatible({ id: 'local', transcriptionModel: 'whisper-1' }),
      true,
    )
    expect(result.defaultProviderId).toBe('local')
    expect(result.defaultTranscriptionProviderId).toBe('local')
  })

  it('does not set a non-transcription-capable entry as transcription default when added as app default', () => {
    const before = state([config({ id: 'oai' })], 'oai', 'oai')
    const result = withAiProviderAdded(
      before,
      config({ id: 'claude', provider: 'anthropic', model: 'claude-fable-5' }),
      true,
    )
    expect(result.defaultProviderId).toBe('claude')
    expect(result.defaultTranscriptionProviderId).toBe('oai')
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

  it('promotes the next transcription-capable entry when the transcription default is removed', () => {
    const providers = [
      config({ id: 'oai', provider: 'openai' }),
      config({ id: 'gemini', provider: 'google', model: 'gemini-2.5-flash' }),
    ]
    const before = state(providers, 'oai', 'oai')
    const result = withAiProviderRemoved(before, 'oai')
    expect(result.defaultTranscriptionProviderId).toBe('gemini')
  })

  it('clears the transcription default when no transcription-capable entries remain', () => {
    const providers = [
      config({ id: 'oai', provider: 'openai' }),
      config({ id: 'claude', provider: 'anthropic', model: 'claude-fable-5' }),
    ]
    const before = state(providers, 'claude', 'oai')
    const result = withAiProviderRemoved(before, 'oai')
    expect(result.defaultTranscriptionProviderId).toBeNull()
  })

  it('leaves the transcription default unchanged when a non-default entry is removed', () => {
    const providers = [
      config({ id: 'oai', provider: 'openai' }),
      config({ id: 'claude', provider: 'anthropic', model: 'claude-fable-5' }),
    ]
    const before = state(providers, 'claude', 'oai')
    const result = withAiProviderRemoved(before, 'claude')
    expect(result.defaultTranscriptionProviderId).toBe('oai')
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
    expect(
      pickTranscriptionConfig({
        providers,
        defaultProviderId: 'second',
        defaultTranscriptionProviderId: 'second',
      })?.id,
    ).toBe('second')
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

  it('returns null when the only openai-compatible entries have unset or disabled transcription models', () => {
    const providers = [
      compatible({ id: 'unset' }),
      compatible({ id: 'off', transcriptionModel: 'disabled' }),
    ]
    expect(pickTranscriptionConfig(state(providers, 'unset'))).toBeNull()
  })

  it('returns null for the empty list', () => {
    expect(pickTranscriptionConfig(state([], null))).toBeNull()
  })

  it('selects an openai-compatible entry when it has a transcription model', () => {
    const providers = [compatible({ id: 'local', transcriptionModel: 'whisper-large-v3' })]
    expect(pickTranscriptionConfig(state(providers, 'local'))?.id).toBe('local')
  })
})

describe('defaultTranscriptionProvider', () => {
  it('returns the entry the transcription default id points at', () => {
    const providers = [
      config({ id: 'oai' }),
      config({ id: 'gemini', provider: 'google', model: 'gemini-2.5-flash' }),
    ]
    expect(defaultTranscriptionProvider(state(providers, 'oai', 'gemini'))?.id).toBe('gemini')
  })

  it('falls back to the first transcription-capable entry when the default is null', () => {
    const providers = [
      config({ id: 'claude', provider: 'anthropic', model: 'claude-fable-5' }),
      config({ id: 'oai', provider: 'openai' }),
    ]
    expect(defaultTranscriptionProvider(state(providers, 'claude', null))?.id).toBe('oai')
  })

  it('skips a dangling or non-transcription-capable default', () => {
    const providers = [
      config({ id: 'claude', provider: 'anthropic', model: 'claude-fable-5' }),
      config({ id: 'gemini', provider: 'google', model: 'gemini-2.5-flash' }),
    ]
    // Anthropic is set as transcription default but doesn't support transcription
    expect(defaultTranscriptionProvider(state(providers, 'claude', 'claude'))?.id).toBe('gemini')
  })

  it('skips a transcription default whose model is disabled', () => {
    const providers = [
      config({ id: 'oai', provider: 'openai' }),
      compatible({ id: 'off', transcriptionModel: 'disabled' }),
    ]
    expect(defaultTranscriptionProvider(state(providers, 'oai', 'off'))?.id).toBe('oai')
  })

  it('returns null when no transcription-capable entries exist', () => {
    const providers = [
      config({ id: 'claude', provider: 'anthropic', model: 'claude-fable-5' }),
      config({ id: 'openrouter', provider: 'openrouter', model: 'openrouter/auto' }),
    ]
    expect(defaultTranscriptionProvider(state(providers, 'claude', null))).toBeNull()
  })
})

describe('transcriptionProviders', () => {
  it('orders OpenAI before Google before openai-compatible', () => {
    const providers = [
      compatible({ id: 'local', transcriptionModel: 'whisper-1' }),
      config({ id: 'gemini', provider: 'google', model: 'gemini-2.5-flash' }),
      config({ id: 'oai', provider: 'openai' }),
    ]
    const result = transcriptionProviders(state(providers, 'oai'))
    expect(result.map((p) => p.provider)).toEqual(['openai', 'google', 'openai-compatible'])
  })

  it('puts the transcription default first within each provider group', () => {
    const providers = [
      config({ id: 'oai-first', provider: 'openai' }),
      config({ id: 'oai-second', provider: 'openai' }),
    ]
    const result = transcriptionProviders(state(providers, 'oai-first', 'oai-second'))
    expect(result.map((p) => p.id)).toEqual(['oai-second', 'oai-first'])
  })

  it('excludes non-transcription-capable providers', () => {
    const providers = [
      config({ id: 'claude', provider: 'anthropic', model: 'claude-fable-5' }),
      config({ id: 'oai', provider: 'openai' }),
      compatible({ id: 'local', transcriptionModel: '' }),
    ]
    const result = transcriptionProviders(state(providers, 'claude'))
    expect(result.map((p) => p.id)).toEqual(['oai'])
  })

  it('excludes an openai-compatible entry whose transcription model is disabled', () => {
    const providers = [
      config({ id: 'oai', provider: 'openai' }),
      compatible({ id: 'off', transcriptionModel: 'disabled' }),
    ]
    const result = transcriptionProviders(state(providers, 'oai'))
    expect(result.map((p) => p.id)).toEqual(['oai'])
  })

  it('returns an empty array when nothing is transcription-capable', () => {
    const providers = [
      config({ id: 'claude', provider: 'anthropic', model: 'claude-fable-5' }),
      compatible({ id: 'local', transcriptionModel: '' }),
    ]
    expect(transcriptionProviders(state(providers, 'claude'))).toEqual([])
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

  it('skips a chat-disabled entry when resolving a null or dangling id', () => {
    const providers = [compatible({ id: 'whisper-only', model: 'disabled' }), config({ id: 'oai' })]
    expect(defaultAiProvider(state(providers, null))?.id).toBe('oai')
    expect(defaultAiProvider(state(providers, 'gone'))?.id).toBe('oai')
  })

  it('skips the stored default when its chat model is disabled', () => {
    const providers = [config({ id: 'oai' }), compatible({ id: 'whisper-only', model: 'disabled' })]
    expect(defaultAiProvider(state(providers, 'whisper-only'))?.id).toBe('oai')
  })

  it('still returns the id-targeted entry when nothing is chat-capable', () => {
    const providers = [
      compatible({ id: 'whisper-only', model: 'disabled', transcriptionModel: 'whisper-1' }),
    ]
    expect(defaultAiProvider(state(providers, 'whisper-only'))?.id).toBe('whisper-only')
    expect(defaultAiProvider(state(providers, null))?.id).toBe('whisper-only')
  })

  it('returns null for the empty list', () => {
    expect(defaultAiProvider(state([], null))).toBeNull()
  })
})

describe('resolveTranscriptionTarget', () => {
  const keyed =
    (available: Record<string, string>) =>
    (config: { id: string }): Promise<string | null> =>
      Promise.resolve(available[config.id] ?? null)

  it('answers no-provider when nothing transcription-capable is configured', async () => {
    const target = await resolveTranscriptionTarget(
      state([config({ id: 'a', provider: 'anthropic' })], 'a'),
      keyed({ a: 'sk-a' }),
    )
    expect(target).toBe('no-provider')
  })

  it('answers no-key when every capable entry is keyless', async () => {
    const target = await resolveTranscriptionTarget(
      state([config({ id: 'openai-1' })], 'openai-1'),
      keyed({}),
    )
    expect(target).toBe('no-key')
  })

  it('prefers OpenAI entries and the transcription default within a provider', async () => {
    const providers = state(
      [
        config({ id: 'google-1', provider: 'google' }),
        config({ id: 'openai-1' }),
        config({ id: 'openai-2' }),
      ],
      'openai-2',
      'openai-2',
    )
    const target = await resolveTranscriptionTarget(
      providers,
      keyed({ 'google-1': 'g', 'openai-1': 'o1', 'openai-2': 'o2' }),
    )
    expect(target).toMatchObject({ config: { id: 'openai-2' }, apiKey: 'o2' })
  })

  it('skips a keyless preferred entry instead of blocking a working one', async () => {
    const providers = state(
      [config({ id: 'openai-1' }), config({ id: 'google-1', provider: 'google' })],
      'openai-1',
      'openai-1',
    )
    const target = await resolveTranscriptionTarget(providers, keyed({ 'google-1': 'g' }))
    expect(target).toMatchObject({ config: { id: 'google-1' }, apiKey: 'g' })
  })

  it('resolves a no-key openai-compatible entry when the keychain has no key', async () => {
    const providers = state(
      [compatible({ id: 'local', transcriptionModel: 'whisper-large-v3', keyHint: '' })],
      'local',
      'local',
    )
    const getKey = vi.fn<(config: AiProviderConfig) => Promise<string | null>>(async (config) =>
      config.id === 'local' ? '' : null,
    )
    const target = await resolveTranscriptionTarget(providers, getKey)
    expect(target).toMatchObject({ config: { id: 'local' }, apiKey: '' })
  })
})
