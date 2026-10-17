import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors.ts'
import type { HostedAiProviderConfig, Settings } from '../settings/schema.ts'
import {
  createTestAiKeyValidationService,
  createTestIdService,
  createTestSecretStoreService,
  createTestSettingsService,
} from '../testing/index.ts'
import { createAiCredentialService } from './ai-credential-service.ts'
import { createAiProviderConfigService, type NewAiProvider } from './ai-provider-config-service.ts'

function entry(overrides: Partial<HostedAiProviderConfig>): HostedAiProviderConfig {
  return {
    id: 'id',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    keyHint: 'wxyz1',
    ...overrides,
  }
}

const A = entry({ id: 'a' })
const B = entry({ id: 'b', provider: 'openai', model: 'gpt-5.5', keyHint: 'abcd2' })

function draft(overrides: Partial<NewAiProvider> = {}): NewAiProvider {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    apiKey: 'sk-ant-test-wxyz1',
    isDefault: false,
    ...overrides,
  }
}

async function createService(
  initial: Partial<Settings> = {},
  options: { failLoad?: boolean; secrets?: Record<string, string> } = {},
) {
  const settings = createTestSettingsService(initial)
  if (options.failLoad === true) {
    settings.failLoad()
  }
  const secretStore = createTestSecretStoreService(options.secrets)
  const keyValidation = createTestAiKeyValidationService()
  const id = createTestIdService()
  const service = createAiProviderConfigService({
    settings,
    credentials: createAiCredentialService({ secretStore }),
    keyValidation,
    id,
  })
  service.list()
  await settings.whenLoaded()
  return { settings, secretStore, keyValidation, id, service }
}

describe('AiProviderConfigService', () => {
  it('lists the entries and resolves the default one', async () => {
    const { service } = await createService({ aiProviders: [A, B], defaultAiProviderId: 'b' })

    expect(service.list()).toEqual([A, B])
    expect(service.defaultProvider()).toEqual(B)
    expect(service.state()).toEqual({ providers: [A, B], defaultProviderId: 'b' })
  })

  it('falls back to the first entry when the default id dangles', async () => {
    const { service } = await createService({ aiProviders: [A, B], defaultAiProviderId: 'gone' })

    expect(service.defaultProvider()).toEqual(A)
  })

  it('has no default entry when the list is empty', async () => {
    const { service } = await createService()

    expect(service.defaultProvider()).toBeNull()
  })

  it('returns a stable list and default entry until the settings change', async () => {
    const { service } = await createService({ aiProviders: [A, B], defaultAiProviderId: 'a' })

    expect(service.list()).toBe(service.list())
    expect(service.defaultProvider()).toBe(service.defaultProvider())
  })

  it('notifies subscribers when the entries change', async () => {
    const { service } = await createService({ aiProviders: [A, B], defaultAiProviderId: 'a' })
    let calls = 0
    const unlisten = service.subscribe(() => {
      calls += 1
    })

    service.makeDefault('b')
    expect(calls).toBe(1)

    unlisten()
    service.makeDefault('a')
    expect(calls).toBe(1)
  })

  it('adds an entry: the key goes to the keychain and only the hint to the settings', async () => {
    const { service, settings, secretStore, id } = await createService()

    await service.add(draft())

    const addedId = id.issued()[0]!
    expect(service.list()).toEqual([
      { id: addedId, provider: 'anthropic', model: 'claude-sonnet-5-5', keyHint: 'wxyz1' },
    ])
    // The first entry becomes the default automatically.
    expect(settings.get().defaultAiProviderId).toBe(addedId)
    expect(secretStore.snapshot()).toEqual({ [`ai-api-key:${addedId}`]: 'sk-ant-test-wxyz1' })
    await settings.flush()
    expect(JSON.stringify(settings.saves())).not.toContain('sk-ant-test-wxyz1')
  })

  it('trims the key before storing it', async () => {
    const { service, secretStore, id } = await createService()

    await service.add(draft({ apiKey: '  sk-ant-test-wxyz1 \n' }))

    expect(secretStore.snapshot()).toEqual({
      [`ai-api-key:${id.issued()[0]!}`]: 'sk-ant-test-wxyz1',
    })
  })

  it('keeps the default when a later entry is added, unless the draft asks for it', async () => {
    const { service, settings, id } = await createService({
      aiProviders: [A],
      defaultAiProviderId: 'a',
    })

    await service.add(draft())
    expect(settings.get().defaultAiProviderId).toBe('a')

    await service.add(draft({ isDefault: true }))
    expect(settings.get().defaultAiProviderId).toBe(id.issued()[1])
  })

  it('adds an OpenAI-compatible endpoint without storing an empty key', async () => {
    const { service, secretStore, id } = await createService()

    await service.add(
      draft({
        provider: 'openai-compatible',
        model: 'llama-local',
        baseUrl: 'http://localhost:1234/v1/',
        apiKey: '',
      }),
    )

    expect(service.list()).toEqual([
      {
        id: id.issued()[0],
        provider: 'openai-compatible',
        model: 'llama-local',
        baseUrl: 'http://localhost:1234/v1',
        keyHint: '',
      },
    ])
    expect(secretStore.snapshot()).toEqual({})
  })

  it('adds nothing when the keychain write fails', async () => {
    const settings = createTestSettingsService()
    const credentials = createAiCredentialService({ secretStore: createTestSecretStoreService() })
    vi.spyOn(credentials, 'store').mockRejectedValue(new AppError('io', 'keychain locked'))
    const service = createAiProviderConfigService({
      settings,
      credentials,
      keyValidation: createTestAiKeyValidationService(),
      id: createTestIdService(),
    })
    service.list()
    await settings.whenLoaded()

    await expect(service.add(draft())).rejects.toMatchObject({ message: 'keychain locked' })

    expect(service.list()).toEqual([])
    await settings.flush()
    expect(settings.saves()).toEqual([])
  })

  it('refuses to add when the settings failed to load, storing no key', async () => {
    const { service, secretStore } = await createService({}, { failLoad: true })

    await expect(service.add(draft())).rejects.toMatchObject({
      kind: 'io',
      message: expect.stringMatching(/could not be loaded/),
    })

    expect(secretStore.snapshot()).toEqual({})
    expect(service.list()).toEqual([])
  })

  it('removes an entry, deletes its key, and promotes the next default', async () => {
    const { service, settings, secretStore } = await createService(
      { aiProviders: [A, B], defaultAiProviderId: 'a' },
      { secrets: { 'ai-api-key:a': 'sk-a', 'ai-api-key:b': 'sk-b' } },
    )

    await service.remove('a')

    expect(service.list()).toEqual([B])
    expect(settings.get().defaultAiProviderId).toBe('b')
    expect(secretStore.snapshot()).toEqual({ 'ai-api-key:b': 'sk-b' })
  })

  it('overlapping removes both land', async () => {
    const { service, settings, secretStore } = await createService(
      { aiProviders: [A, B], defaultAiProviderId: 'a' },
      { secrets: { 'ai-api-key:a': 'sk-a', 'ai-api-key:b': 'sk-b' } },
    )

    await Promise.all([service.remove('a'), service.remove('b')])

    expect(service.list()).toEqual([])
    expect(settings.get().defaultAiProviderId).toBeNull()
    expect(secretStore.snapshot()).toEqual({})
  })

  it('makes an entry the default', async () => {
    const { service } = await createService({ aiProviders: [A, B], defaultAiProviderId: 'a' })

    service.makeDefault('b')

    expect(service.defaultProvider()).toEqual(B)
    expect(service.list()).toEqual([A, B])
  })

  it('changes the default model of one entry, and ignores a blank model', async () => {
    const { service } = await createService({ aiProviders: [A, B], defaultAiProviderId: 'a' })

    service.setDefaultModel('b', ' gpt-5.4-mini ')
    expect(service.list()).toEqual([A, { ...B, model: 'gpt-5.4-mini' }])

    service.setDefaultModel('b', '   ')
    expect(service.list()).toEqual([A, { ...B, model: 'gpt-5.4-mini' }])
  })

  describe('checkDraft', () => {
    it('verifies the key and returns the normalized draft', async () => {
      const { service, keyValidation } = await createService()

      const check = await service.checkDraft(draft({ apiKey: ' sk-ant-key ' }), {
        unverified: false,
      })

      expect(check).toEqual({
        status: 'ready',
        draft: draft({ apiKey: 'sk-ant-key', baseUrl: undefined }),
      })
      expect(keyValidation.calls()).toEqual([
        { provider: 'anthropic', apiKey: 'sk-ant-key', baseUrl: undefined },
      ])
    })

    it('rejects a missing key without a probe', async () => {
      const { service, keyValidation } = await createService()

      const check = await service.checkDraft(draft({ apiKey: '  ' }), { unverified: false })

      expect(check).toEqual({ status: 'rejected', message: 'Enter an API key.' })
      expect(keyValidation.calls()).toEqual([])
    })

    it('rejects an OpenAI-compatible draft without an http(s) base URL', async () => {
      const { service, keyValidation } = await createService()

      const check = await service.checkDraft(
        draft({ provider: 'openai-compatible', apiKey: '', baseUrl: 'ftp://example.com' }),
        { unverified: false },
      )

      expect(check).toEqual({ status: 'rejected', message: 'Enter an http(s) endpoint URL.' })
      expect(keyValidation.calls()).toEqual([])
    })

    it('normalizes the base URL of an OpenAI-compatible draft and allows an empty key', async () => {
      const { service, keyValidation } = await createService()

      const check = await service.checkDraft(
        draft({
          provider: 'openai-compatible',
          model: 'llama-local',
          apiKey: '',
          baseUrl: 'http://localhost:1234/v1/',
        }),
        { unverified: false },
      )

      expect(check).toMatchObject({
        status: 'ready',
        draft: { apiKey: '', baseUrl: 'http://localhost:1234/v1' },
      })
      expect(keyValidation.calls()).toEqual([
        { provider: 'openai-compatible', apiKey: '', baseUrl: 'http://localhost:1234/v1' },
      ])
    })

    it('rejects a key the provider turns down', async () => {
      const { service, keyValidation } = await createService()
      keyValidation.setResult('invalid')

      expect(await service.checkDraft(draft(), { unverified: false })).toEqual({
        status: 'rejected',
        message: 'Anthropic rejected this API key.',
      })
      expect(
        await service.checkDraft(
          draft({ provider: 'openai-compatible', apiKey: '', baseUrl: 'http://localhost:1234/v1' }),
          { unverified: false },
        ),
      ).toEqual({
        status: 'rejected',
        message: 'OpenAI-compatible endpoint requires an API key.',
      })
    })

    it('reports an unreachable provider, and skips the probe for an unverified save', async () => {
      const { service, keyValidation } = await createService()
      keyValidation.setResult('unreachable')

      expect(await service.checkDraft(draft(), { unverified: false })).toEqual({
        status: 'unreachable',
      })
      expect(await service.checkDraft(draft(), { unverified: true })).toMatchObject({
        status: 'ready',
      })
      expect(keyValidation.calls()).toHaveLength(1)
    })
  })

  it('offers the chat models and resolves the saved chat selection', async () => {
    const { service, settings } = await createService({
      aiProviders: [A, B],
      defaultAiProviderId: 'a',
    })

    expect(service.chatModelOptions().map((option) => option.configId)).toContain('b')
    expect(service.chatModel()).toEqual(A)

    service.selectChatModel({ configId: 'b', modelId: 'gpt-5.4-mini' })
    expect(settings.get().chatModelSelection).toEqual({ configId: 'b', modelId: 'gpt-5.4-mini' })
    expect(service.chatModel()).toEqual({ ...B, model: 'gpt-5.4-mini' })

    service.selectChatModel({ configId: 'gone', modelId: 'x' })
    expect(service.chatModel()).toEqual(A)
  })

  it('picks the transcription entry and resolves its key', async () => {
    const { service } = await createService(
      { aiProviders: [A, B], defaultAiProviderId: 'a' },
      { secrets: { 'ai-api-key:b': 'sk-b' } },
    )

    expect(service.transcriptionConfig()).toEqual(B)
    expect(await service.resolveTranscriptionTarget()).toEqual({ config: B, apiKey: 'sk-b' })
    expect(await service.resolveTranscriptionTarget(async () => null)).toBe('no-key')
  })

  it('reports no transcription provider when none is capable', async () => {
    const { service } = await createService({ aiProviders: [A], defaultAiProviderId: 'a' })

    expect(service.transcriptionConfig()).toBeNull()
    expect(await service.resolveTranscriptionTarget()).toBe('no-provider')
  })

  it('picks the small-model entry for audio memo enrichment', async () => {
    const { service } = await createService({ aiProviders: [A, B], defaultAiProviderId: 'b' })

    expect(service.audioMemoEnrichmentConfig()).toMatchObject({ id: 'b', provider: 'openai' })
    expect(service.audioMemoEnrichmentConfig()?.model).not.toBe(B.model)
  })
})
