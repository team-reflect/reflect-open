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

/** {@link modelAnswering}, for the well-formed `{title, description}` shape. */
function modelAnsweringObject(title: string, description: string): LanguageModelV3CallOptions[] {
  return modelAnswering(JSON.stringify({ title, description }))
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

function userText(calls: LanguageModelV3CallOptions[]): string {
  const message = calls[0]!.prompt.find((candidate) => candidate.role === 'user')
  const parts = message?.content as Array<{ type: string; text?: string }>
  return parts.find((part) => part.type === 'text')?.text ?? ''
}

describe('describePage', () => {
  it('returns the trimmed title and description, grounding the call in the screenshot', async () => {
    const calls = modelAnsweringObject('  A cleaned title  ', '  A concise description.  ')

    const result = await request({
      selection: 'highlighted words',
      metaTitle: 'A meta title',
      siteName: 'Example',
      metaDescription: 'A scraped description.',
      screenshotBase64: 'aGVsbG8=',
    })

    expect(result).toEqual({ title: 'A cleaned title', description: 'A concise description.' })
    expect(calls).toHaveLength(1)
    const text = userText(calls)
    expect(text).toContain('https://example.com/article')
    expect(text).toContain('An article')
    expect(text).toContain('A meta title')
    expect(text).toContain('Site name: Example')
    expect(text).toContain('A scraped description.')
    expect(text).toContain('highlighted words')
    const message = calls[0]!.prompt.find((candidate) => candidate.role === 'user')
    const parts = message!.content as Array<{ type: string; mediaType?: string }>
    const image = parts.find((part) => part.type === 'file')
    expect(image?.mediaType).toBe('image/jpeg')
  })

  it('sends a text-only prompt when no screenshot was captured', async () => {
    const calls = modelAnsweringObject('A title', 'A description.')

    await request()

    const message = calls[0]!.prompt.find((candidate) => candidate.role === 'user')
    const parts = message!.content as Array<{ type: string }>
    expect(parts.map((part) => part.type)).toEqual(['text'])
  })

  it('tells the model to rebuild share-sheet boilerplate titles from the page', async () => {
    const calls = modelAnsweringObject('A title', 'A description.')

    await request()

    const text = userText(calls)
    expect(text).toContain('share sheets often supply boilerplate')
    expect(text).toContain('build the title from the meta title, page text, or screenshot')
  })

  it('sanitizes the returned title for wiki-link display', async () => {
    modelAnsweringObject(' An [article] | Site\nName ', 'A description.')

    const result = await request()

    expect(result.title).toBe('An article Site Name')
  })

  it('clips a runaway title at a word boundary', async () => {
    modelAnsweringObject(`${'word '.repeat(30)}end`, 'A description.')

    const result = await request()

    expect(result.title!.length).toBeLessThanOrEqual(100)
    expect(result.title).toMatch(/word$/)
  })

  it('a blank title reads as null — the caller keeps the captured title', async () => {
    modelAnsweringObject('  [|]  ', 'A description.')

    const result = await request()

    expect(result.title).toBeNull()
    expect(result.description).toBe('A description.')
  })

  it('caps a runaway selection in the prompt', async () => {
    const calls = modelAnsweringObject('A title', 'A description.')

    await request({ selection: 'x'.repeat(5_000) })

    expect(userText(calls)).not.toContain('x'.repeat(1_001))
  })

  it('adds extracted page text to the prompt and caps long pages', async () => {
    const calls = modelAnsweringObject('A title', 'A description.')

    await request({ contentText: `Important opening paragraph.\n\n${'x'.repeat(7_000)}` })

    const text = userText(calls)
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

  it('an unparseable answer becomes DescriptionRejectedError, never a crash', async () => {
    modelAnswering('not an object at all')
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
