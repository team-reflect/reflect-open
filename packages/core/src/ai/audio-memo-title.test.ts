import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import type { LanguageModelV3Usage } from '@ai-sdk/provider'
import type { AiProviderConfig } from '../settings/schema'
import {
  generateAudioMemoTitle,
  pickAudioMemoEnrichmentConfig,
} from './audio-memo-title'
import { languageModel } from './language-model'

vi.mock('./language-model', () => ({
  languageModel: vi.fn(),
}))

const languageModelMock = vi.mocked(languageModel)

const USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}

const CONFIG: AiProviderConfig = {
  id: 'cfg-openai',
  provider: 'openai',
  model: 'gpt-5.5',
  keyHint: 'wxyz1',
}

const ANTHROPIC_CONFIG: AiProviderConfig = {
  id: 'cfg-anthropic',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  keyHint: 'wxyz1',
}

const GOOGLE_CONFIG: AiProviderConfig = {
  id: 'cfg-google',
  provider: 'google',
  model: 'gemini-3.1-pro-preview',
  keyHint: 'wxyz1',
}

const OPENROUTER_CONFIG: AiProviderConfig = {
  id: 'cfg-openrouter',
  provider: 'openrouter',
  model: 'openrouter/auto',
  keyHint: 'wxyz1',
}

beforeEach(() => {
  vi.clearAllMocks()
})

function modelAnswering(text: string): void {
  languageModelMock.mockReturnValue(
    new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ title: text }) }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: USAGE,
        warnings: [],
      }),
    }),
  )
}

function modelThrowing(error: unknown): void {
  languageModelMock.mockReturnValue(
    new MockLanguageModelV3({
      doGenerate: async () => {
        throw error
      },
    }),
  )
}

function request(transcript = 'talked about planning the Rome trip'): Promise<string> {
  return generateAudioMemoTitle({
    credentials: { config: CONFIG, apiKey: 'sk-live-key' },
    transcript,
    fallbackTitle: 'Audio memo 2026-06-11 15:30:22',
  })
}

describe('generateAudioMemoTitle', () => {
  it('returns a sanitized generated title', async () => {
    modelAnswering('  Rome itinerary!  ')

    await expect(request()).resolves.toBe('Rome itinerary')
  })

  it.each([
    [CONFIG, 'gpt-5.5', 'gpt-5.4-nano'],
    [ANTHROPIC_CONFIG, 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    [GOOGLE_CONFIG, 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite'],
  ])('uses the fixed small model for %s', async (config, originalModel, titleModel) => {
    modelAnswering('Planning notes')

    await generateAudioMemoTitle({
      credentials: { config, apiKey: 'sk-live-key' },
      transcript: 'planning notes',
      fallbackTitle: 'Audio memo 2026-06-11 15:30:22',
    })

    expect(config.model).toBe(originalModel)
    expect(languageModelMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: config.id, provider: config.provider, model: titleModel }),
      'sk-live-key',
      expect.any(Function),
    )
  })

  it('falls back to the transcript when the provider returns nothing useful', async () => {
    modelAnswering('[]')

    await expect(request('first idea. second idea')).resolves.toBe('First idea')
  })

  it('falls back to the transcript when the provider call fails', async () => {
    modelThrowing(new Error('model unavailable'))

    await expect(request('review launch checklist and beta feedback')).resolves.toBe(
      'Review launch checklist and beta feedback',
    )
  })

  it('uses the timestamp fallback for empty transcripts', async () => {
    modelAnswering('Ignored')

    await expect(request('')).resolves.toBe('Audio memo 2026-06-11 15:30:22')
    expect(languageModelMock).not.toHaveBeenCalled()
  })

  it('uses the transcript fallback when title credentials are absent', async () => {
    modelAnswering('Ignored')

    await expect(
      generateAudioMemoTitle({
        transcript: 'review launch checklist',
        fallbackTitle: 'Audio memo 2026-06-11 15:30:22',
      }),
    ).resolves.toBe('Review launch checklist')
    expect(languageModelMock).not.toHaveBeenCalled()
  })

  it('prefers the default supported provider for title generation', () => {
    expect(
      pickAudioMemoEnrichmentConfig({
        providers: [CONFIG, ANTHROPIC_CONFIG],
        defaultProviderId: ANTHROPIC_CONFIG.id,
      }),
    ).toMatchObject({
      id: ANTHROPIC_CONFIG.id,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    })
  })

  it('skips OpenRouter because it does not guarantee a small model', () => {
    expect(
      pickAudioMemoEnrichmentConfig({
        providers: [OPENROUTER_CONFIG, GOOGLE_CONFIG],
        defaultProviderId: OPENROUTER_CONFIG.id,
      }),
    ).toMatchObject({
      id: GOOGLE_CONFIG.id,
      provider: 'google',
      model: 'gemini-3.1-flash-lite',
    })
  })
})
