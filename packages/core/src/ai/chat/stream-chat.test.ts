import { describe, expect, it } from 'vitest'
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test'
import type {
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from '@ai-sdk/provider'
import type { RetrievalHit } from '../../embeddings/retrieve'
import { cloudSafeGraphContext } from '../checkers'
import { MAX_STEPS, streamChatTurn, type ChatStreamEvent } from './stream-chat'

const USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}

// Sentinels that cannot collide with prompt copy or fixture prose, so the
// not-in-payload assertions below can never pass vacuously.
const PRIVATE_TITLE = 'sentinel-title-01jxq3'
const PRIVATE_PATH = 'notes/sentinel-path-01jxq3.md'

function stream(parts: LanguageModelV3StreamPart[]): LanguageModelV3StreamResult {
  return {
    stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
      { type: 'stream-start', warnings: [] },
      { type: 'response-metadata', id: 'res', modelId: 'mock', timestamp: new Date(0) },
      ...parts,
    ]),
  }
}

/**
 * One stream result per doStream call, in order. (The mock's own array form
 * indexes by the post-push call count, skipping element 0 — a function keeps
 * the sequencing explicit instead.)
 */
function sequence(results: LanguageModelV3StreamResult[]): () => Promise<LanguageModelV3StreamResult> {
  let index = 0
  return async () => {
    const next = results[index]
    index += 1
    if (next === undefined) {
      throw new Error(`mock model called ${index} times but only ${results.length} turns staged`)
    }
    return next
  }
}

function toolCallTurn(query: string, toolCallId = 'call-1') {
  return stream([
    {
      type: 'tool-call',
      toolCallId,
      toolName: 'search_notes',
      input: JSON.stringify({ query }),
    },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE },
  ])
}

function textTurn(text: string) {
  return stream([
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: text },
    { type: 'text-end', id: 'text-1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE },
  ])
}

async function collect(events: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const all: ChatStreamEvent[] = []
  for await (const event of events) {
    all.push(event)
  }
  return all
}

const PUBLIC_HIT: RetrievalHit = {
  path: 'notes/atlas.md',
  title: 'Atlas Launch Plan',
  score: 1,
  snippet: 'launch plan',
  heading: null,
  isPrivate: false,
}

const PRIVATE_HIT: RetrievalHit = {
  path: PRIVATE_PATH,
  title: PRIVATE_TITLE,
  score: 0.9,
  snippet: '',
  heading: null,
  isPrivate: true,
}

describe('streamChatTurn', () => {
  it('streams tool activity, text, and a terminal complete event', async () => {
    const model = new MockLanguageModelV3({
      doStream: sequence([toolCallTurn('atlas'), textTurn('Found it: [[Atlas Launch Plan]]')]),
    })
    const events = await collect(
      streamChatTurn(model, {
        messages: [{ role: 'user', content: 'where is the launch plan?' }],
        today: '2026-06-11',
        context: null,
        toolDeps: { retrieveFn: async () => [PUBLIC_HIT, PRIVATE_HIT], readNoteFn: async () => 'launch plan\n' },
      }),
    )

    expect(events.map((event) => event.type)).toEqual([
      'tool-call',
      'tool-result',
      'text-delta',
      'complete',
    ])
    expect(events[0]).toEqual({
      type: 'tool-call',
      call: { tool: 'search', toolCallId: 'call-1', query: 'atlas' },
    })
    // The private hit is dropped before it ever reaches an event or payload.
    expect(events[1]).toEqual({
      type: 'tool-result',
      result: {
        tool: 'search',
        toolCallId: 'call-1',
        query: 'atlas',
        hits: [{ path: 'notes/atlas.md', title: 'Atlas Launch Plan' }],
      },
    })
    expect(events[2]).toMatchObject({ text: 'Found it: [[Atlas Launch Plan]]' })
    const complete = events.at(-1)
    expect(complete?.type === 'complete' && complete.messages.length > 0).toBe(true)
  })

  it('never sends private content in the outbound prompt (payload assertion)', async () => {
    const model = new MockLanguageModelV3({
      doStream: sequence([toolCallTurn('diary'), textTurn('done')]),
    })
    await collect(
      streamChatTurn(model, {
        messages: [{ role: 'user', content: 'what do my notes say?' }],
        today: '2026-06-11',
        context: null,
        toolDeps: { retrieveFn: async () => [PUBLIC_HIT, PRIVATE_HIT], readNoteFn: async () => 'launch plan\n' },
      }),
    )

    // Every prompt that left for the "provider", including the second step
    // carrying the tool result, must be free of the private note.
    expect(model.doStreamCalls.length).toBe(2)
    const outbound = JSON.stringify(model.doStreamCalls.map((call) => call.prompt))
    expect(outbound).not.toContain(PRIVATE_TITLE)
    expect(outbound).not.toContain(PRIVATE_PATH)
    expect(outbound).toContain('notes/atlas.md')
  })

  it('carries the graph overview in the outbound system prompt', async () => {
    const model = new MockLanguageModelV3({ doStream: sequence([textTurn('hi')]) })
    await collect(
      streamChatTurn(model, {
        messages: [{ role: 'user', content: 'hi' }],
        today: '2026-06-11',
        context: cloudSafeGraphContext({
          graphName: 'atlas-graph',
          noteCount: 7,
          dailyNoteCount: 2,
          earliestDailyDate: '2026-06-01',
          latestDailyDate: '2026-06-10',
          tags: [{ tag: 'book', count: 2 }],
          tagsTruncated: false,
        }),
      }),
    )

    const outbound = JSON.stringify(model.doStreamCalls[0]?.prompt)
    expect(outbound).toContain('atlas-graph')
    expect(outbound).toContain('#book (2)')
    expect(outbound).toContain('Daily notes span 2026-06-01 to 2026-06-10.')
  })

  it('yields a terminal error event when the stream errors', async () => {
    const model = new MockLanguageModelV3({
      doStream: sequence([
        stream([
          { type: 'error', error: new Error('rate limited') },
          { type: 'finish', finishReason: { unified: 'error', raw: undefined }, usage: USAGE },
        ]),
      ]),
    })
    const events = await collect(
      streamChatTurn(model, {
        messages: [{ role: 'user', content: 'hi' }],
        today: '2026-06-11',
        context: null,
      }),
    )
    expect(events.at(-1)).toEqual({ type: 'error', message: 'rate limited', messages: [] })
  })

  it('a cut-short turn still carries the completed steps, properly paired', async () => {
    // Step 1 completes (tool call + result); step 2 streams text, then errors.
    const model = new MockLanguageModelV3({
      doStream: sequence([
        toolCallTurn('atlas'),
        stream([
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: 'So far' },
          { type: 'error', error: new Error('connection lost') },
          { type: 'finish', finishReason: { unified: 'error', raw: undefined }, usage: USAGE },
        ]),
      ]),
    })
    const events = await collect(
      streamChatTurn(model, {
        messages: [{ role: 'user', content: 'where is the launch plan?' }],
        today: '2026-06-11',
        context: null,
        toolDeps: { retrieveFn: async () => [PUBLIC_HIT], readNoteFn: async () => 'launch plan\n' },
      }),
    )

    const last = events.at(-1)
    if (last?.type !== 'error') {
      expect.unreachable('expected a terminal error event')
    }
    // The completed step's assistant (tool call) + tool (result) pair survives,
    // plus the interrupted step's partial text — never a dangling tool call.
    expect(last.messages.map((message) => message.role)).toEqual(['assistant', 'tool', 'assistant'])
    expect(JSON.stringify(last.messages.at(-1))).toContain('So far')
  })

  it('keeps every completed step when cut short after multiple tool rounds', async () => {
    // Pins the SDK semantic the engine relies on: each onStepFinish's
    // `response.messages` is *cumulative* across steps, so assigning (not
    // appending) yields the full paired history. If an `ai` upgrade ever
    // makes it per-step, this starts failing instead of silently dropping
    // earlier rounds.
    const model = new MockLanguageModelV3({
      doStream: sequence([
        toolCallTurn('atlas', 'call-1'),
        toolCallTurn('budget', 'call-2'),
        stream([
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: 'So far' },
          { type: 'error', error: new Error('connection lost') },
          { type: 'finish', finishReason: { unified: 'error', raw: undefined }, usage: USAGE },
        ]),
      ]),
    })
    const events = await collect(
      streamChatTurn(model, {
        messages: [{ role: 'user', content: 'plan and budget?' }],
        today: '2026-06-11',
        context: null,
        toolDeps: { retrieveFn: async () => [PUBLIC_HIT], readNoteFn: async () => 'launch plan\n' },
      }),
    )

    const last = events.at(-1)
    if (last?.type !== 'error') {
      expect.unreachable('expected a terminal error event')
    }
    expect(last.messages.map((message) => message.role)).toEqual([
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ])
    const outbound = JSON.stringify(last.messages)
    expect(outbound).toContain('call-1')
    expect(outbound).toContain('call-2')
  })

  it('disables tools on the final step so a tool-bound turn still answers', async () => {
    // Every gathering step calls a tool; the model only writes its answer
    // once tools are disabled on the last permitted step. Without that force,
    // the turn would end on a tool result with no reply.
    const gathering = Array.from({ length: MAX_STEPS - 1 }, (_unused, index) =>
      toolCallTurn(`query-${index}`, `call-${index}`),
    )
    const model = new MockLanguageModelV3({
      doStream: sequence([...gathering, textTurn('Summary: [[Atlas Launch Plan]]')]),
    })
    const events = await collect(
      streamChatTurn(model, {
        messages: [{ role: 'user', content: 'summarize everything' }],
        today: '2026-06-11',
        context: null,
        toolDeps: { retrieveFn: async () => [PUBLIC_HIT], readNoteFn: async () => 'body\n' },
      }),
    )

    // Every step ran, gathering steps kept tools on, and the final step was
    // forced to answer rather than call another tool.
    expect(model.doStreamCalls.length).toBe(MAX_STEPS)
    expect(model.doStreamCalls[0]?.toolChoice).toEqual({ type: 'auto' })
    expect(model.doStreamCalls.at(-1)?.toolChoice).toEqual({ type: 'none' })
    expect(events.at(-1)?.type).toBe('complete')
    expect(events.some((event) => event.type === 'text-delta')).toBe(true)
  })
})
