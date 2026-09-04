import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { cloudSafeSelection } from '../privacy/checkers'
import { languageModel } from './language-model'
import { transformSelection, type TransformSelectionOptions } from './transform-selection'

vi.mock('./language-model', () => ({ languageModel: vi.fn() }))

const options: TransformSelectionOptions = {
  config: { id: 'cfg', provider: 'openai', model: 'gpt-5.5', keyHint: 'test' },
  apiKey: 'sk-test',
  fetchFn: globalThis.fetch,
  promptBody: 'Fix {{selectedText}}',
  selection: cloudSafeSelection({ path: 'notes/public.md', isPrivate: false }, 'teh text'),
}

describe('selection model loading', () => {
  it('does not call the provider after aborting during model loading', async () => {
    const controller = new AbortController()
    const loading = Promise.withResolvers<Awaited<ReturnType<typeof languageModel>>>()
    vi.mocked(languageModel).mockReturnValueOnce(loading.promise)
    const model = new MockLanguageModelV3()
    const next = transformSelection({ ...options, signal: controller.signal }).next()
    controller.abort()
    loading.resolve(model)

    expect(await next).toEqual({ done: false, value: { type: 'aborted' } })
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('returns a terminal error event when the model chunk fails to load', async () => {
    vi.mocked(languageModel).mockRejectedValueOnce(new Error('model chunk unavailable'))
    const stream = transformSelection(options)

    expect(await stream.next()).toEqual({
      done: false,
      value: { type: 'error', message: 'model chunk unavailable' },
    })
    expect(await stream.next()).toEqual({ done: true, value: undefined })
  })
})
