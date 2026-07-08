import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedAiProviderConfig, OpenAiCompatibleProviderConfig } from '../settings/schema'

const getSecret = vi.hoisted(() => vi.fn<(name: string) => Promise<string | null>>())

vi.mock('../secrets/keychain', () => ({ getSecret }))

const { aiApiKeyForConfig } = await import('./secrets')

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

beforeEach(() => {
  getSecret.mockReset()
})

describe('aiApiKeyForConfig', () => {
  it('returns stored keys for configured providers', async () => {
    getSecret.mockResolvedValue('sk-live')
    await expect(aiApiKeyForConfig(hostedConfig({}))).resolves.toBe('sk-live')
  })

  it('allows a no-key OpenAI-compatible endpoint', async () => {
    getSecret.mockResolvedValue(null)
    await expect(
      aiApiKeyForConfig(openAiCompatibleConfig({ keyHint: '' })),
    ).resolves.toBe('')
  })

  it('reports a missing key when an OpenAI-compatible entry was saved with one', async () => {
    getSecret.mockResolvedValue(null)
    await expect(
      aiApiKeyForConfig(openAiCompatibleConfig({ keyHint: '12345' })),
    ).resolves.toBeNull()
  })
})
