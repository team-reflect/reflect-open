import { describe, expect, it, vi } from 'vitest'
import type { AiProviderConfig } from '../settings/schema'
import { describeAsset } from './describe-asset'
import { describePage } from './describe-page'
import { languageModel } from './language-model'

vi.mock('ai', () => {
  throw new Error('AI SDK chunk unavailable')
})
vi.mock('@ai-sdk/openai', () => {
  throw new Error('provider chunk unavailable')
})

const config: AiProviderConfig = {
  id: 'cfg',
  provider: 'openai',
  model: 'gpt-5.5',
  keyHint: 'test',
}

describe('AI chunk load failures', () => {
  it('keeps page enrichment retryable without contacting its provider', async () => {
    const transport = vi.fn<typeof fetch>()
    await expect(
      describePage({
        config,
        apiKey: 'sk-test',
        fetchFn: transport,
        url: 'https://example.com',
        title: 'Example',
      }),
    ).rejects.toMatchObject({ kind: 'network', message: expect.stringContaining('load AI') })
    expect(transport).not.toHaveBeenCalled()
  })

  it('keeps asset enrichment retryable without contacting its provider', async () => {
    const transport = vi.fn<typeof fetch>()
    await expect(
      describeAsset({
        config,
        apiKey: 'sk-test',
        fetchFn: transport,
        kind: 'image',
        mediaType: 'image/png',
        data: 'aGVsbG8=',
        filename: 'diagram.png',
      }),
    ).rejects.toMatchObject({ kind: 'network', message: expect.stringContaining('load AI') })
    expect(transport).not.toHaveBeenCalled()
  })

  it('keeps selected provider load failures retryable', async () => {
    const transport = vi.fn<typeof fetch>()
    await expect(languageModel(config, 'sk-test', transport)).rejects.toMatchObject({
      kind: 'network',
      message: expect.stringContaining('load AI'),
    })
    expect(transport).not.toHaveBeenCalled()
  })
})
