import { expect, it, vi } from 'vitest'
import type { AiProviderConfig } from '../settings/schema'
import { APP_REVIEW_STUB_KEY } from './app-review-demo'

const loaded = vi.hoisted(() => new Set<string>())

vi.mock('@ai-sdk/openai', async (original) => {
  loaded.add('openai')
  return await original<typeof import('@ai-sdk/openai')>()
})
vi.mock('@ai-sdk/anthropic', async (original) => {
  loaded.add('anthropic')
  return await original<typeof import('@ai-sdk/anthropic')>()
})
vi.mock('@ai-sdk/google', async (original) => {
  loaded.add('google')
  return await original<typeof import('@ai-sdk/google')>()
})
vi.mock('@ai-sdk/openai-compatible', async (original) => {
  loaded.add('openai-compatible')
  return await original<typeof import('@ai-sdk/openai-compatible')>()
})

it('loads no SDK for configuration or demo mode, then only each selected implementation', async () => {
  const { aiProvider } = await import('./provider-catalog')
  const { languageModel } = await import('./language-model')
  const transport = vi.fn<typeof fetch>()
  const config: AiProviderConfig = {
    id: 'cfg',
    provider: 'openai',
    model: 'gpt-5.5',
    keyHint: 'test',
  }
  expect(aiProvider('anthropic').id).toBe('anthropic')
  expect(loaded).toEqual(new Set())

  await languageModel(config, APP_REVIEW_STUB_KEY, transport)
  expect(loaded).toEqual(new Set())

  await languageModel(config, 'sk-test', transport)
  expect(loaded).toEqual(new Set(['openai']))
  await languageModel({ ...config, provider: 'openrouter' }, 'sk-test', transport)
  expect(loaded).toEqual(new Set(['openai']))
  await languageModel({ ...config, provider: 'anthropic' }, 'sk-test', transport)
  expect(loaded).toEqual(new Set(['openai', 'anthropic']))
  await languageModel({ ...config, provider: 'google' }, 'sk-test', transport)
  expect(loaded).toEqual(new Set(['openai', 'anthropic', 'google']))
  await languageModel(
    { ...config, provider: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' },
    '',
    transport,
  )
  expect(loaded).toEqual(new Set(['openai', 'anthropic', 'google', 'openai-compatible']))
  expect(transport).not.toHaveBeenCalled()
})
