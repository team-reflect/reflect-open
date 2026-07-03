import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import type { LanguageModelV3Usage } from '@ai-sdk/provider'
import type { AiProviderConfig } from '../settings/schema'
import { generateAudioMemoTitle } from './audio-memo-title'
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

beforeEach(() => {
  vi.clearAllMocks()
})

function modelAnswering(text: string): void {
  languageModelMock.mockReturnValue(
    new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text', text }],
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
    config: CONFIG,
    apiKey: 'sk-live-key',
    transcript,
    fallbackTitle: 'Audio memo 2026-06-11 15:30:22',
  })
}

describe('generateAudioMemoTitle', () => {
  it('returns a sanitized generated title', async () => {
    modelAnswering('  - [[Rome itinerary|Rome itinerary!]]  ')

    await expect(request()).resolves.toBe('Rome itinerary')
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
})
