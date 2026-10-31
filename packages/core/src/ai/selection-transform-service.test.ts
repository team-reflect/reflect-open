import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { describe, expect, it, vi } from 'vitest'
import type { LanguageModel } from '@reflect/modules/ai'
import { convertArrayToReadableStream, MockLanguageModelV3 } from '@reflect/modules/ai/test'
import type {
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from '@ai-sdk/provider'
import { createPrivacyService } from '../privacy/privacy-service.ts'
import type { AiProviderConfig } from '../settings/schema.ts'
import { createAiCredentialService } from './ai-credential-service.ts'
import { createAiProviderConfigService } from './ai-provider-config-service.ts'
import {
  createTestAiKeyValidationService,
  createTestIdService,
  createTestLanguageModelService,
  createTestLoggerService,
  createTestNoteFileService,
  createTestSecretStoreService,
  createTestSettingsService,
  type TestLanguageModelSource,
} from '../testing/index.ts'
import {
  createSelectionTransformService,
  streamTransformTurn,
  type SelectionTransformRequest,
  type TransformStreamEvent,
} from './selection-transform-service.ts'

const USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}

function stream(parts: LanguageModelV3StreamPart[]): LanguageModelV3StreamResult {
  return {
    stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
      { type: 'stream-start', warnings: [] },
      { type: 'response-metadata', id: 'res', modelId: 'mock', timestamp: new Date(0) },
      ...parts,
    ]),
  }
}

function textStream(deltas: string[]): LanguageModelV3StreamResult {
  return stream([
    { type: 'text-start', id: 'text-1' },
    ...deltas.map((delta): LanguageModelV3StreamPart => ({
      type: 'text-delta',
      id: 'text-1',
      delta,
    })),
    { type: 'text-end', id: 'text-1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE },
  ])
}

async function collect(
  events: AsyncGenerator<TransformStreamEvent>,
): Promise<TransformStreamEvent[]> {
  const all: TransformStreamEvent[] = []
  for await (const event of events) {
    all.push(event)
  }
  return all
}

describe('streamTransformTurn', () => {
  it('streams deltas and terminates with complete carrying the full text', async () => {
    const model = new MockLanguageModelV3({
      doStream: () => Promise.resolve(textStream(['good', 'bye'])),
    })
    const events = await collect(
      streamTransformTurn({ logger: createTestLoggerService() }, model, {
        prompt: 'Fix: teh text',
      }),
    )

    expect(events).toEqual([
      { type: 'text-delta', text: 'good' },
      { type: 'text-delta', text: 'bye' },
      { type: 'complete', text: 'goodbye' },
    ])
  })

  it('sends the rendered prompt and the transform system prompt', async () => {
    const model = new MockLanguageModelV3({
      doStream: () => Promise.resolve(textStream(['ok'])),
    })
    await collect(
      streamTransformTurn({ logger: createTestLoggerService() }, model, {
        prompt: 'Fix: teh text',
      }),
    )

    expect(model.doStreamCalls.length).toBe(1)
    const outbound = JSON.stringify(model.doStreamCalls[0]?.prompt)
    expect(outbound).toContain('Fix: teh text')
    expect(outbound).toContain('only the resulting Markdown')
  })

  it('terminates with a single error event when the provider fails', async () => {
    const model = new MockLanguageModelV3({
      doStream: () => Promise.reject(new Error('provider exploded')),
    })
    const logger = createTestLoggerService()
    const events = await collect(streamTransformTurn({ logger }, model, { prompt: 'x' }))

    expect(events).toEqual([{ type: 'error', message: 'provider exploded' }])
    expect(logger.getErrors()).toEqual([
      { message: 'selection transform stream failed:', cause: new Error('provider exploded') },
    ])
  })

  it('terminates with aborted when the signal fires before the call', async () => {
    const controller = new AbortController()
    controller.abort()
    const model = new MockLanguageModelV3({
      doStream: () => Promise.resolve(textStream(['never'])),
    })
    const events = await collect(
      streamTransformTurn({ logger: createTestLoggerService() }, model, {
        prompt: 'x',
        signal: controller.signal,
      }),
    )

    expect(events.at(-1)?.type).toBe('aborted')
  })
})

const OPENAI: AiProviderConfig = { id: 'a', provider: 'openai', model: 'gpt-5.5', keyHint: 'aaaa1' }
const ANTHROPIC: AiProviderConfig = {
  id: 'b',
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  keyHint: 'bbbb2',
}

async function createService(
  options: {
    providers?: AiProviderConfig[]
    secrets?: Record<string, string>
    model?: TestLanguageModelSource
  } = {},
) {
  const providers = options.providers ?? [OPENAI, ANTHROPIC]
  const settings = createTestSettingsService({
    aiProviders: providers,
    defaultAiProviderId: providers[0]?.id ?? null,
  })
  const credentials = createAiCredentialService({
    secretStore: createTestSecretStoreService(
      options.secrets ?? { 'ai-api-key:a': 'sk-a', 'ai-api-key:b': 'sk-b' },
    ),
  })
  const providerConfig = createAiProviderConfigService({
    settings,
    credentials,
    keyValidation: createTestAiKeyValidationService(),
    id: createTestIdService(),
  })
  providerConfig.list()
  await settings.whenLoaded()
  const languageModel = createTestLanguageModelService(
    options.model ??
      new MockLanguageModelV3({ doStream: () => Promise.resolve(textStream(['good', 'bye'])) }),
  )
  const service = createSelectionTransformService({
    logger: createTestLoggerService(),
    languageModel,
    providerConfig,
    credentials,
    privacy: createPrivacyService({
      noteFile: createTestNoteFileService(),
      graphSession: createTestGraphSessionService({ graph: { generation: 1 } }),
    }),
  })
  return { service, languageModel }
}

function request(overrides: Partial<SelectionTransformRequest> = {}): SelectionTransformRequest {
  return {
    note: { path: 'notes/public.md', isPrivate: false },
    selectedText: 'teh text',
    promptBody: 'Fix {{selectedText}}',
    model: null,
    ...overrides,
  }
}

describe('SelectionTransformService', () => {
  it('streams the transform from the default entry with its key', async () => {
    const model = new MockLanguageModelV3({
      doStream: () => Promise.resolve(textStream(['good', 'bye'])),
    })
    const { service, languageModel } = await createService({ model })

    const events = await collect(service.transform(request()))

    expect(events).toEqual([
      { type: 'text-delta', text: 'good' },
      { type: 'text-delta', text: 'bye' },
      { type: 'complete', text: 'goodbye' },
    ])
    expect(languageModel.calls()).toEqual([{ config: OPENAI, apiKey: 'sk-a' }])
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain('Fix teh text')
  })

  it('calls the entry and model of a model override', async () => {
    const { service, languageModel } = await createService()

    await collect(
      service.transform(
        request({
          model: {
            configId: 'b',
            provider: 'anthropic',
            modelId: 'claude-sonnet-5-5',
            label: 'Claude Sonnet 5.5',
          },
        }),
      ),
    )

    expect(languageModel.calls()).toEqual([
      { config: { ...ANTHROPIC, model: 'claude-sonnet-5-5' }, apiKey: 'sk-b' },
    ])
  })

  it('ends with an error when no provider is configured', async () => {
    const { service, languageModel } = await createService({ providers: [] })

    expect(await collect(service.transform(request()))).toEqual([
      { type: 'error', message: 'Add an AI provider in Settings to use AI prompts.' },
    ])
    expect(languageModel.calls()).toEqual([])
  })

  it('ends with an error when the override entry was removed', async () => {
    const { service, languageModel } = await createService()

    const events = await collect(
      service.transform(
        request({ model: { configId: 'gone', provider: 'openai', modelId: 'x', label: 'x' } }),
      ),
    )

    expect(events).toEqual([
      { type: 'error', message: 'Add an AI provider in Settings to use AI prompts.' },
    ])
    expect(languageModel.calls()).toEqual([])
  })

  it('never sends the selection of a private note', async () => {
    const { service, languageModel } = await createService()

    const events = await collect(
      service.transform(request({ note: { path: 'notes/secret.md', isPrivate: true } })),
    )

    expect(events).toEqual([
      {
        type: 'error',
        message: 'This note is marked private, so its content is never sent to an AI provider.',
      },
    ])
    expect(languageModel.calls()).toEqual([])
  })

  it('ends with an error when the entry has no key', async () => {
    const { service, languageModel } = await createService({ secrets: {} })

    expect(await collect(service.transform(request()))).toEqual([
      {
        type: 'error',
        message: 'No API key found for this provider — re-add it in Settings → AI providers.',
      },
    ])
    expect(languageModel.calls()).toEqual([])
  })

  it('does not call the provider after aborting during model loading', async () => {
    const controller = new AbortController()
    const loading = Promise.withResolvers<LanguageModel>()
    const { service, languageModel } = await createService({ model: () => loading.promise })
    const model = new MockLanguageModelV3()
    const next = service.transform(request({ signal: controller.signal })).next()
    await vi.waitFor(() => expect(languageModel.calls()).toHaveLength(1))
    controller.abort()
    loading.resolve(model)

    expect(await next).toEqual({ done: false, value: { type: 'aborted' } })
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('returns a terminal error event when the model fails to load', async () => {
    const { service } = await createService({
      model: () => Promise.reject(new Error('model chunk unavailable')),
    })
    const stream = service.transform(request())

    expect(await stream.next()).toEqual({
      done: false,
      value: { type: 'error', message: 'model chunk unavailable' },
    })
    expect(await stream.next()).toEqual({ done: true, value: undefined })
  })
})
