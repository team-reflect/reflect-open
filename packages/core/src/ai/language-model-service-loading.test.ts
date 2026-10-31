import { expect, it } from 'vitest'
import type { AiProviderConfig } from '../settings/schema.ts'
import { createTestHttpService } from '../testing/index.ts'
import { APP_REVIEW_STUB_KEY } from './app-review-demo.ts'
import {
  createLanguageModelService,
  createLazyAiSdkLoader,
  type AiSdkLoader,
} from './language-model-service.ts'

it('loads no SDK for demo mode, then only each selected implementation', async () => {
  const loaded = new Set<string>()
  const lazy = createLazyAiSdkLoader()
  const sdk: AiSdkLoader = {
    openai: () => {
      loaded.add('openai')
      return lazy.openai()
    },
    anthropic: () => {
      loaded.add('anthropic')
      return lazy.anthropic()
    },
    google: () => {
      loaded.add('google')
      return lazy.google()
    },
    openaiCompatible: () => {
      loaded.add('openai-compatible')
      return lazy.openaiCompatible()
    },
  }
  const http = createTestHttpService()
  const languageModel = createLanguageModelService({ http, sdk })
  const config: AiProviderConfig = {
    id: 'cfg',
    provider: 'openai',
    model: 'gpt-5.5',
    keyHint: 'test',
  }
  expect(loaded).toEqual(new Set())

  await languageModel.create(config, APP_REVIEW_STUB_KEY)
  expect(loaded).toEqual(new Set())

  await languageModel.create(config, 'sk-test')
  expect(loaded).toEqual(new Set(['openai']))
  await languageModel.create({ ...config, provider: 'openrouter' }, 'sk-test')
  expect(loaded).toEqual(new Set(['openai']))
  await languageModel.create({ ...config, provider: 'anthropic' }, 'sk-test')
  expect(loaded).toEqual(new Set(['openai', 'anthropic']))
  await languageModel.create({ ...config, provider: 'google' }, 'sk-test')
  expect(loaded).toEqual(new Set(['openai', 'anthropic', 'google']))
  await languageModel.create(
    { ...config, provider: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' },
    '',
  )
  expect(loaded).toEqual(new Set(['openai', 'anthropic', 'google', 'openai-compatible']))
  expect(http.requests()).toEqual([])
})
