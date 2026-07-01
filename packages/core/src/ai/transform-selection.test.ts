import { describe, expect, it } from 'vitest'
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test'
import type {
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from '@ai-sdk/provider'
import { streamTransformTurn, type TransformStreamEvent } from './transform-selection'

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
    ...deltas.map(
      (delta): LanguageModelV3StreamPart => ({ type: 'text-delta', id: 'text-1', delta }),
    ),
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
      doStream: async () => textStream(['good', 'bye']),
    })
    const events = await collect(streamTransformTurn(model, { prompt: 'Fix: teh text' }))

    expect(events).toEqual([
      { type: 'text-delta', text: 'good' },
      { type: 'text-delta', text: 'bye' },
      { type: 'complete', text: 'goodbye' },
    ])
  })

  it('sends the rendered prompt and the transform system prompt', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => textStream(['ok']),
    })
    await collect(streamTransformTurn(model, { prompt: 'Fix: teh text' }))

    expect(model.doStreamCalls.length).toBe(1)
    const outbound = JSON.stringify(model.doStreamCalls[0]?.prompt)
    expect(outbound).toContain('Fix: teh text')
    expect(outbound).toContain('only the resulting Markdown')
  })

  it('terminates with a single error event when the provider fails', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => {
        throw new Error('provider exploded')
      },
    })
    const events = await collect(streamTransformTurn(model, { prompt: 'x' }))

    expect(events).toEqual([{ type: 'error', message: 'provider exploded' }])
  })

  it('terminates with aborted when the signal fires before the call', async () => {
    const controller = new AbortController()
    controller.abort()
    const model = new MockLanguageModelV3({
      doStream: async () => textStream(['never']),
    })
    const events = await collect(
      streamTransformTurn(model, { prompt: 'x', signal: controller.signal }),
    )

    expect(events.at(-1)?.type).toBe('aborted')
  })
})
