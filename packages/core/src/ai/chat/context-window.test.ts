import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { estimateTokens, fitToContextWindow } from './context-window'

/**
 * Budget math under test (empty system prompt): the usable budget is
 * `(contextWindow − 60_000 turn reserve) × 0.8`, so a window of 61_000
 * yields an 800-token budget — small enough to drive trimming with
 * hand-sized messages (4 chars ≈ 1 token, +4 per message).
 */
function windowForBudget(budget: number): number {
  return 60_000 + Math.ceil(budget / 0.8)
}

function turn(userChars: number, assistantChars: number): ModelMessage[] {
  return [
    { role: 'user', content: 'u'.repeat(userChars) },
    { role: 'assistant', content: 'a'.repeat(assistantChars) },
  ]
}

function toolExchange(callId: string, outputChars: number): ModelMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: callId, toolName: 'read_note', input: { path: 'notes/a.md' } },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: callId,
          toolName: 'read_note',
          output: { type: 'json', value: { content: 'n'.repeat(outputChars) } },
        },
      ],
    },
  ]
}

describe('estimateTokens', () => {
  it('counts text by length and adds per-message overhead', () => {
    expect(estimateTokens({ role: 'user', content: 'x'.repeat(400) })).toBe(104)
  })

  it('counts images flat — never by data-URL length', () => {
    const photo: ModelMessage = {
      role: 'user',
      content: [
        { type: 'image', image: `data:image/png;base64,${'a'.repeat(400_000)}`, mediaType: 'image/png' },
      ],
    }
    expect(estimateTokens(photo)).toBe(1_604)
  })

  it('counts tool results by their JSON encoding', () => {
    const [, result] = toolExchange('tool-1', 4_000)
    const tokens = estimateTokens(result!)
    expect(tokens).toBeGreaterThan(1_000)
    expect(tokens).toBeLessThan(1_100)
  })
})

describe('fitToContextWindow', () => {
  it('passes an under-budget history through untouched', () => {
    const messages = [...turn(400, 400), ...turn(400, 400)]
    expect(
      fitToContextWindow(messages, { contextWindow: 1_000_000, systemPrompt: '' }),
    ).toBe(messages)
  })

  it('drops the oldest turns whole, at user-message boundaries', () => {
    const oldest = turn(2_000, 2_000)
    const middle = turn(2_000, 2_000)
    const newest = turn(2_000, 2_000)
    // Each turn ≈ 1_008 tokens; budget fits two but not three.
    const fitted = fitToContextWindow([...oldest, ...middle, ...newest], {
      contextWindow: windowForBudget(2_200),
      systemPrompt: '',
    })
    expect(fitted).toEqual([...middle, ...newest])
  })

  it('elides old tool results before dropping any turn', () => {
    const oldest: ModelMessage[] = [
      { role: 'user', content: 'find my note' },
      ...toolExchange('tool-old', 8_000),
      { role: 'assistant', content: 'Found it.' },
    ]
    const middle = turn(200, 200)
    const newest: ModelMessage[] = [
      { role: 'user', content: 'read it again' },
      ...toolExchange('tool-new', 200),
      { role: 'assistant', content: 'Here you go.' },
    ]
    // Raw ≈ 2_300 tokens (the old 8k-char tool dump); elided ≈ 450 — over
    // an 800-token budget only the bulk needs to go, not any turn.
    const fitted = fitToContextWindow([...oldest, ...middle, ...newest], {
      contextWindow: windowForBudget(800),
      systemPrompt: '',
    })

    const users = fitted.filter((message) => message.role === 'user')
    expect(users).toHaveLength(3)

    const toolMessages = fitted.filter((message) => message.role === 'tool')
    expect(toolMessages).toHaveLength(2)
    expect(toolMessages[0]!.content[0]).toMatchObject({
      toolCallId: 'tool-old',
      output: { type: 'text', value: '[Old tool result elided to fit the context window.]' },
    })
    // The newest turns keep their results verbatim — the model may still be
    // working from them.
    expect(toolMessages[1]!.content[0]).toMatchObject({
      toolCallId: 'tool-new',
      output: { type: 'json' },
    })
    // The pairing survives elision: the call part is still there.
    const calls = fitted.filter(
      (message) =>
        message.role === 'assistant' &&
        typeof message.content !== 'string' &&
        message.content.some((part) => part.type === 'tool-call'),
    )
    expect(calls).toHaveLength(2)
  })

  it('keeps the newest turn even when it alone overruns the budget', () => {
    const messages = turn(40_000, 40_000)
    const fitted = fitToContextWindow(messages, {
      contextWindow: windowForBudget(800),
      systemPrompt: '',
    })
    expect(fitted).toEqual(messages)
  })

  it('counts the system prompt against the budget', () => {
    const messages = [...turn(2_000, 2_000), ...turn(2_000, 2_000)]
    const roomy = fitToContextWindow(messages, {
      contextWindow: windowForBudget(2_200),
      systemPrompt: '',
    })
    expect(roomy).toHaveLength(4)
    // The same window with a fat system prompt no longer fits both turns.
    const squeezed = fitToContextWindow(messages, {
      contextWindow: windowForBudget(2_200),
      systemPrompt: 's'.repeat(8_000),
    })
    expect(squeezed).toEqual(messages.slice(2))
  })
})
