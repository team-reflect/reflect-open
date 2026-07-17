import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import type { LanguageModelV3Usage } from '@ai-sdk/provider'
import type { AiProviderConfig } from '../settings/schema'
import { formatAudioMemoTranscript } from './audio-memo-format'
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

const FALLBACK_TITLE = 'Audio memo 2026-06-11 15:30:22'

beforeEach(() => {
  vi.clearAllMocks()
})

function modelAnswering(output: { title: string; body: string }): MockLanguageModelV3 {
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: JSON.stringify(output) }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: USAGE,
      warnings: [],
    }),
  })
  languageModelMock.mockReturnValue(model)
  return model
}

function request(transcript: string) {
  return formatAudioMemoTranscript({
    credentials: { config: CONFIG, apiKey: 'sk-live-key' },
    transcript,
    fallbackTitle: FALLBACK_TITLE,
  })
}

describe('formatAudioMemoTranscript', () => {
  it('returns readable Markdown and a sanitized title from one small-model call', async () => {
    modelAnswering({
      title: '  Launch planning!  ',
      body: 'We reviewed the launch.\n\n## Next steps\n\n- Invite beta users',
    })

    await expect(request('we reviewed the launch next steps invite beta users')).resolves.toEqual({
      title: 'Launch planning',
      body: 'We reviewed the launch.\n\n## Next steps\n\n- Invite beta users',
    })
    expect(languageModelMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.4-nano' }),
      'sk-live-key',
      expect.any(Function),
    )
  })

  it('frames the complete transcript as untrusted data and forbids meaning changes', async () => {
    const tail = 'TAIL_MARKER_AFTER_A_LONG_TRANSCRIPT'
    const transcript = `${'word '.repeat(10_000)}${tail}`
    const model = modelAnswering({ title: 'Long memo', body: 'Formatted memo' })

    const result = await request(transcript)

    const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt)
    expect(prompt).toContain('untrusted quoted data')
    expect(prompt).toContain('Do not summarize, omit, invent')
    expect(prompt).toContain('coherent paragraphs')
    expect(prompt).toContain(tail)
    expect(result.body).toBe(transcript)
    expect(result.title).not.toBe('Long memo')
  })

  it('falls back to the untouched transcript and a local title when the call fails', async () => {
    languageModelMock.mockReturnValue(
      new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error('model unavailable')
        },
      }),
    )

    await expect(request('review launch checklist and beta feedback')).resolves.toEqual({
      title: 'Review launch checklist and beta feedback',
      body: 'review launch checklist and beta feedback',
    })
  })

  it('falls back when structured output contains an empty body', async () => {
    modelAnswering({ title: 'Ignored', body: '   ' })

    await expect(request('first idea. second idea')).resolves.toEqual({
      title: 'First idea',
      body: 'first idea. second idea',
    })
  })

  it('falls back when a same-length response does not retain the transcript', async () => {
    const transcript = 'review the launch timeline and invite the beta group tomorrow'
    modelAnswering({
      title: 'Unrelated response',
      body: 'clouds crossed the quiet valley while distant bells rang softly',
    })

    await expect(request(transcript)).resolves.toEqual({
      title: 'Review the launch timeline and invite the beta',
      body: transcript,
    })
  })

  it('falls back when a response repeats transcript content', async () => {
    const transcript = 'Review the launch timeline tomorrow.'
    modelAnswering({
      title: 'Repeated response',
      body: `${transcript} ${transcript}`,
    })

    await expect(request(transcript)).resolves.toEqual({
      title: 'Review the launch timeline tomorrow',
      body: transcript,
    })
  })

  it('falls back when formatting swaps named entities', async () => {
    const transcript = 'Alice will send the draft, and Bob will review the budget.'
    modelAnswering({
      title: 'Swapped owners',
      body: 'Bob will send the draft, and Alice will review the budget.',
    })

    await expect(request(transcript)).resolves.toEqual({
      title: 'Alice will send the draft, and bob will',
      body: transcript,
    })
  })

  it('falls back when formatting drops a meaningful combining mark', async () => {
    const transcript = 'यह किताब मेरी है और इसे रखना है'
    modelAnswering({
      title: 'किताब रखना',
      body: 'यह कतब मेरी है और इसे रखना है।',
    })

    const result = await request(transcript)
    expect(result.body).toBe(transcript)
    expect(result.title).not.toBe('किताब रखना')
  })

  it('falls back when formatting changes a signed decimal percentage', async () => {
    const transcript = 'The margin fell to -1.5% today'
    modelAnswering({
      title: 'Margin update',
      body: 'The margin fell to 15% today.',
    })

    const result = await request(transcript)
    expect(result.body).toBe(transcript)
    expect(result.title).not.toBe('Margin update')
  })

  it.each([
    ['drops a currency sign', 'The budget changed by -$50 today', 'The budget changed by $50 today.'],
    ['changes a suffix currency', 'The price is 50€ today', 'The price is 50$ today.'],
    ['drops a spaced percentage', 'The margin is 50 % today', 'The margin is 50 today.'],
  ])('falls back when formatting %s', async (_case, transcript, body) => {
    modelAnswering({ title: 'Changed number', body })

    const result = await request(transcript)
    expect(result.body).toBe(transcript)
    expect(result.title).not.toBe('Changed number')
  })

  it('does not call a model for an empty transcript', async () => {
    modelAnswering({ title: 'Ignored', body: 'Ignored' })

    await expect(request('')).resolves.toEqual({ title: FALLBACK_TITLE, body: '' })
    expect(languageModelMock).not.toHaveBeenCalled()
  })
})
