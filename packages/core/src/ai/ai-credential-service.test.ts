import { describe, expect, it, vi } from 'vitest'
import type { HostedAiProviderConfig, OpenAiCompatibleProviderConfig } from '../settings/schema.ts'
import { createTestSecretStoreService } from '../testing/index.ts'
import { createAiCredentialService } from './ai-credential-service.ts'

function hostedConfig(overrides: Partial<HostedAiProviderConfig>): HostedAiProviderConfig {
  return {
    id: 'cfg',
    provider: 'openai',
    model: 'gpt-5.4',
    keyHint: '12345',
    ...overrides,
  }
}

function openAiCompatibleConfig(
  overrides: Partial<OpenAiCompatibleProviderConfig>,
): OpenAiCompatibleProviderConfig {
  return {
    id: 'cfg-local',
    provider: 'openai-compatible',
    model: 'llama-local',
    baseUrl: 'http://localhost:1234/v1',
    keyHint: '',
    ...overrides,
  }
}

describe('AiCredentialService', () => {
  it('returns stored keys for configured providers', async () => {
    const credentials = createAiCredentialService({
      secretStore: createTestSecretStoreService({ 'ai-api-key:cfg': 'sk-live' }),
    })
    await expect(credentials.read(hostedConfig({}))).resolves.toBe('sk-live')
  })

  it('allows a no-key OpenAI-compatible endpoint', async () => {
    const credentials = createAiCredentialService({ secretStore: createTestSecretStoreService() })
    await expect(credentials.read(openAiCompatibleConfig({ keyHint: '' }))).resolves.toBe('')
  })

  it('reports a missing key when an OpenAI-compatible entry was saved with one', async () => {
    const credentials = createAiCredentialService({ secretStore: createTestSecretStoreService() })
    await expect(credentials.read(openAiCompatibleConfig({ keyHint: '12345' }))).resolves.toBeNull()
  })

  it('stores and removes the key of an entry under its keychain name', async () => {
    const secretStore = createTestSecretStoreService()
    const credentials = createAiCredentialService({ secretStore })

    await credentials.store('cfg', 'sk-live')
    expect(secretStore.snapshot()).toEqual({ 'ai-api-key:cfg': 'sk-live' })

    await credentials.remove('cfg')
    expect(secretStore.snapshot()).toEqual({})
  })

  it('reads each entry at most once per pass reader', async () => {
    const secretStore = createTestSecretStoreService({ 'ai-api-key:cfg': 'sk-live' })
    const credentials = createAiCredentialService({ secretStore })
    const getKey = credentials.createPassReader()

    await expect(getKey('cfg')).resolves.toBe('sk-live')
    await secretStore.set('ai-api-key:cfg', 'sk-rotated')
    await expect(getKey('cfg')).resolves.toBe('sk-live')
    await expect(credentials.createPassReader()('cfg')).resolves.toBe('sk-rotated')
  })

  it('reads a keychain failure as a missing key in a pass reader', async () => {
    const secretStore = createTestSecretStoreService()
    vi.spyOn(secretStore, 'get').mockRejectedValue(new Error('keychain locked'))
    const credentials = createAiCredentialService({ secretStore })
    await expect(credentials.createPassReader()('cfg')).resolves.toBeNull()
  })
})
