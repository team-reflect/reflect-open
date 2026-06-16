import { describe, expect, it, vi } from 'vitest'
import { APICallError } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import type { LanguageModelV3CallOptions, LanguageModelV3Usage } from '@ai-sdk/provider'
import type { AiProviderConfig } from '../settings/schema'
import { describePage, isDescriptionRejected } from './describe-page'
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

/** Install a mock model answering `text`; returns the captured call options. */
function modelAnswering(text: string): LanguageModelV3CallOptions[] {
  const calls: LanguageModelV3CallOptions[] = []
  languageModelMock.mockReturnValue(
    new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls.push(options)
        return {
          content: [{ type: 'text', text }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: USAGE,
          warnings: [],
        }
      },
    }),
  )
  return calls
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

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: `provider answered ${statusCode}`,
    url: 'https://api.openai.com/v1/responses',
    requestBodyValues: {},
    statusCode,
  })
}

function request(overrides: Partial<Parameters<typeof describePage>[0]> = {}) {
  return describePage({
    config: CONFIG,
    apiKey: 'sk-live-key',
    url: 'https://example.com/article',
    title: 'An article',
    ...overrides,
  })
}

describe('describePage', () => {
  it('returns the trimmed description and grounds the call in the screenshot', async () => {
    const calls = modelAnswering('  A concise description.  ')

    const description = await request({
      selection: 'highlighted words',
      metaDescription: 'A scraped description.',
      screenshotBase64: 'aGVsbG8=',
    })

    expect(description).toBe('A concise description.')
    expect(calls).toHaveLength(1)
    const [message] = calls[0]!.prompt
    expect(message!.role).toBe('user')
    const parts = message!.content as Array<{ type: string; mediaType?: string; text?: string }>
    const text = parts.find((part) => part.type === 'text')?.text ?? ''
    expect(text).toContain('https://example.com/article')
    expect(text).toContain('An article')
    expect(text).toContain('A scraped description.')
    expect(text).toContain('highlighted words')
    const image = parts.find((part) => part.type === 'file')
    expect(image?.mediaType).toBe('image/jpeg')
  })

  it('sends a text-only prompt when no screenshot was captured', async () => {
    const calls = modelAnswering('A description.')

    await request()

    const parts = calls[0]!.prompt[0]!.content as Array<{ type: string }>
    expect(parts.map((part) => part.type)).toEqual(['text'])
  })

  it('caps a runaway selection in the prompt', async () => {
    const calls = modelAnswering('A description.')

    await request({ selection: 'x'.repeat(5_000) })

    const parts = calls[0]!.prompt[0]!.content as Array<{ type: string; text?: string }>
    const text = parts.find((part) => part.type === 'text')?.text ?? ''
    expect(text).not.toContain('x'.repeat(1_001))
  })

  it('adds extracted page text to the prompt and caps long pages', async () => {
    const calls = modelAnswering('A description.')

    await request({ contentText: `Important opening paragraph.\n\n${'x'.repeat(7_000)}` })

    const parts = calls[0]!.prompt[0]!.content as Array<{ type: string; text?: string }>
    const text = parts.find((part) => part.type === 'text')?.text ?? ''
    expect(text).toContain('Extracted page text: Important opening paragraph.')
    expect(text).not.toContain('x'.repeat(6_001))
  })

  it.each([
    [401, 'auth'],
    [403, 'auth'],
  ])('a %d from the provider throws an auth error (stop the pass)', async (status, kind) => {
    modelThrowing(apiError(status))
    await expect(request()).rejects.toMatchObject({ kind })
  })

  it.each([
    [429, 'network'],
    [500, 'network'],
    [503, 'network'],
  ])('a %d from the provider throws a network error (retry later)', async (status, kind) => {
    modelThrowing(apiError(status))
    await expect(request()).rejects.toMatchObject({ kind })
  })

  it('a 4xx refusal becomes DescriptionRejectedError — the caller falls back to meta', async () => {
    modelThrowing(apiError(413))
    const failure = await request().catch((cause: unknown) => cause)
    expect(isDescriptionRejected(failure)).toBe(true)
  })

  it('a timeout reads as a network error', async () => {
    modelThrowing(new DOMException('timed out', 'TimeoutError'))
    await expect(request()).rejects.toMatchObject({ kind: 'network' })
  })

  it('an unrecognized failure propagates unwrapped', async () => {
    const cause = new Error('something else entirely')
    modelThrowing(cause)
    await expect(request()).rejects.toBe(cause)
  })
})
