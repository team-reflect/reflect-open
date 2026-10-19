import { beforeEach, describe, expect, it } from 'vitest'
import { createTestLanguageModelService, type TestLanguageModelService } from '../testing/index.ts'
import { MockLanguageModelV3 } from '@reflect/modules/ai/test'
import type { LanguageModelV3CallOptions, LanguageModelV3Usage } from '@ai-sdk/provider'
import type { AiProviderConfig } from '../settings/schema.ts'
import {
  createTranscriptEnrichmentService,
  FORMAT_MAX_CHARS,
  pickAudioMemoEnrichmentConfig,
  TITLE_INPUT_MAX_CHARS,
  type TranscriptEnrichmentService,
} from './transcript-enrichment-service.ts'

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

let languageModelService: TestLanguageModelService
let enrichment: TranscriptEnrichmentService

beforeEach(() => {
  languageModelService = createTestLanguageModelService()
  enrichment = createTranscriptEnrichmentService({ languageModel: languageModelService })
})

function modelAnswering(text: string): void {
  languageModelService.setModel(
    new MockLanguageModelV3({
      doGenerate: () => {
        return Promise.resolve({
          content: [{ type: 'text', text: JSON.stringify({ title: text }) }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: USAGE,
          warnings: [],
        })
      },
    }),
  )
}

function modelThrowing(error: unknown): void {
  languageModelService.setModel(
    new MockLanguageModelV3({
      doGenerate: () => {
        return Promise.try(() => {
          throw error
        })
      },
    }),
  )
}

function request(transcript = 'talked about planning the Rome trip'): Promise<string> {
  return enrichment.generateTitle({
    credentials: { config: CONFIG, apiKey: 'sk-live-key' },
    transcript,
    fallbackTitle: 'Audio memo 2026-06-11 15:30:22',
  })
}

describe('TranscriptEnrichmentService.generateTitle', () => {
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

    await enrichment.generateTitle({
      credentials: { config, apiKey: 'sk-live-key' },
      transcript: 'planning notes',
      fallbackTitle: 'Audio memo 2026-06-11 15:30:22',
    })

    expect(config.model).toBe(originalModel)
    const calls = languageModelService.calls().map((call) => ({
      id: call.config.id,
      provider: call.config.provider,
      model: call.config.model,
      apiKey: call.apiKey,
    }))
    expect(calls).toContainEqual({
      id: config.id,
      provider: config.provider,
      model: titleModel,
      apiKey: 'sk-live-key',
    })
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
    expect(languageModelService.calls()).toEqual([])
  })

  it('uses the transcript fallback when title credentials are absent', async () => {
    modelAnswering('Ignored')

    await expect(
      enrichment.generateTitle({
        transcript: 'review launch checklist',
        fallbackTitle: 'Audio memo 2026-06-11 15:30:22',
      }),
    ).resolves.toBe('Review launch checklist')
    expect(languageModelService.calls()).toEqual([])
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

describe('TranscriptEnrichmentService.enrich', () => {
  const FALLBACK_TITLE = 'Audio memo 2026-06-11 15:30:22'
  const CREDENTIALS = { config: CONFIG, apiKey: 'sk-live-key' }

  /**
   * Install a model answering `output` as JSON; returns the captured call options.
   */
  function modelAnsweringObject(output: Record<string, string>): LanguageModelV3CallOptions[] {
    const calls: LanguageModelV3CallOptions[] = []
    languageModelService.setModel(
      new MockLanguageModelV3({
        doGenerate: (options) => {
          calls.push(options)
          return Promise.resolve({
            content: [{ type: 'text', text: JSON.stringify(output) }],
            finishReason: { unified: 'stop' as const, raw: undefined },
            usage: USAGE,
            warnings: [],
          })
        },
      }),
    )
    return calls
  }

  function promptText(call: LanguageModelV3CallOptions): string {
    const message = call.prompt.find((candidate) => candidate.role === 'user')
    const parts = message?.content as Array<{ type: string; text?: string }>
    return parts.find((part) => part.type === 'text')?.text ?? ''
  }

  it('formats and names the transcript in one call when formatting is on', async () => {
    const calls = modelAnsweringObject({ title: 'Rome trip', body: 'Talked about Rome.' })

    await expect(
      enrichment.enrich({
        transcript: 'talked about rome',
        enrichmentCredentials: CREDENTIALS,
        formatTranscript: true,
        fallbackTitle: FALLBACK_TITLE,
      }),
    ).resolves.toEqual({ title: 'Rome trip', body: 'Talked about Rome.' })
    expect(calls).toHaveLength(1)
    expect(promptText(calls[0]!)).toContain('Transcript JSON string:')
  })

  it('only names the transcript when formatting is off', async () => {
    const calls = modelAnsweringObject({ title: 'Rome trip' })

    await expect(
      enrichment.enrich({
        transcript: 'talked about rome',
        enrichmentCredentials: CREDENTIALS,
        formatTranscript: false,
        fallbackTitle: FALLBACK_TITLE,
      }),
    ).resolves.toEqual({ title: 'Rome trip', body: 'talked about rome' })
    expect(calls).toHaveLength(1)
    expect(promptText(calls[0]!)).toContain('Name this audio memo')
  })

  it('only names a transcript that is too long to format, from its opening', async () => {
    const calls = modelAnsweringObject({ title: 'Long meeting' })
    const transcript = `${'a'.repeat(TITLE_INPUT_MAX_CHARS)}${'b'.repeat(FORMAT_MAX_CHARS)}`

    await expect(
      enrichment.enrich({
        transcript,
        enrichmentCredentials: CREDENTIALS,
        formatTranscript: true,
        fallbackTitle: FALLBACK_TITLE,
      }),
    ).resolves.toEqual({ title: 'Long meeting', body: transcript })
    expect(calls).toHaveLength(1)
    expect(promptText(calls[0]!)).toContain('Name this audio memo')
    expect(promptText(calls[0]!)).not.toContain('b')
  })

  it('names the transcript locally when there are no credentials', async () => {
    modelAnsweringObject({ title: 'Ignored' })

    await expect(
      enrichment.enrich({
        transcript: 'review launch checklist',
        enrichmentCredentials: null,
        formatTranscript: true,
        fallbackTitle: FALLBACK_TITLE,
      }),
    ).resolves.toEqual({ title: 'Review launch checklist', body: 'review launch checklist' })
    expect(languageModelService.calls()).toEqual([])
  })
})
