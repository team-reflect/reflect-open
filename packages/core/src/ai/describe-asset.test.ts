import { APICallError } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import type { LanguageModelV3CallOptions, LanguageModelV3Usage } from '@ai-sdk/provider'
import { describe, expect, it, vi } from 'vitest'
import type { AiProviderConfig } from '../settings/schema'
import { describeAsset, isAssetDescriptionRejected, type DescribeAssetRequest } from './describe-asset'
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
  id: 'cfg-anthropic',
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  keyHint: 'wxyz1',
}

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
    url: 'https://api.anthropic.com/v1/messages',
    requestBodyValues: {},
    statusCode,
  })
}

function request(overrides: Partial<DescribeAssetRequest> = {}): Promise<string> {
  return describeAsset({
    config: CONFIG,
    apiKey: 'sk-live-key',
    kind: 'image',
    mediaType: 'image/png',
    data: 'aGVsbG8=',
    filename: 'diagram.png',
    ...overrides,
  })
}

type PromptPart = { type: string; mediaType?: string; text?: string }

function partsOf(calls: LanguageModelV3CallOptions[]): PromptPart[] {
  return calls[0]!.prompt[0]!.content as PromptPart[]
}

describe('describeAsset', () => {
  it('returns the trimmed description and sends an image as a file part', async () => {
    const calls = modelAnswering('  A flow diagram.  ')

    const body = await request()

    expect(body).toBe('A flow diagram.')
    // AI SDK normalizes image parts to file parts at the call-options level.
    const image = partsOf(calls).find((part) => part.type === 'file')
    expect(image?.mediaType).toBe('image/png')
    const text = partsOf(calls).find((part) => part.type === 'text')?.text ?? ''
    expect(text).toContain('diagram.png')
    expect(text).toContain('image')
  })

  it('sends a PDF as a file part with its media type', async () => {
    const calls = modelAnswering('A report.')

    await request({ kind: 'pdf', mediaType: 'application/pdf', filename: 'report.pdf' })

    const file = partsOf(calls).find((part) => part.type === 'file')
    expect(file?.mediaType).toBe('application/pdf')
    const text = partsOf(calls).find((part) => part.type === 'text')?.text ?? ''
    expect(text).toContain('PDF document')
  })

  it('sends an SVG as text, never as an image/file part', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><title>Logo</title></svg>'
    const calls = modelAnswering('A logo.')

    await request({ kind: 'svg', mediaType: 'image/svg+xml', data: svg, filename: 'logo.svg' })

    const parts = partsOf(calls)
    expect(parts.every((part) => part.type === 'text')).toBe(true)
    expect(parts.map((part) => part.text).join('\n')).toContain('<title>Logo</title>')
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

  it('a 4xx refusal becomes AssetDescriptionRejectedError — log only, no description', async () => {
    modelThrowing(apiError(415))
    const failure = await request().catch((cause: unknown) => cause)
    expect(isAssetDescriptionRejected(failure)).toBe(true)
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
