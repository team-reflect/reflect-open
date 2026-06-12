import { describe, expect, it } from 'vitest'
import type { ChatStreamEvent } from '@reflect/core'
import { appendEvent, buildHistory, type AssistantPart, type ChatTurn } from './chat-transcript'

function fold(events: ChatStreamEvent[]): AssistantPart[] {
  return events.reduce<AssistantPart[]>(appendEvent, [])
}

describe('appendEvent', () => {
  it('merges consecutive text deltas into one part', () => {
    expect(
      fold([
        { type: 'text-delta', text: 'Hello ' },
        { type: 'text-delta', text: 'world' },
      ]),
    ).toEqual([{ kind: 'text', text: 'Hello world' }])
  })

  it('keeps text around tool activity as separate parts', () => {
    const parts = fold([
      { type: 'text-delta', text: 'Looking… ' },
      { type: 'tool-call', call: { tool: 'search', toolCallId: 'tool-1', query: 'atlas' } },
      {
        type: 'tool-result',
        result: {
          tool: 'search',
          toolCallId: 'tool-1',
          query: 'atlas',
          hits: [{ path: 'notes/a.md', title: 'Atlas' }],
        },
      },
      { type: 'text-delta', text: 'Found it.' },
    ])
    expect(parts).toEqual([
      { kind: 'text', text: 'Looking… ' },
      {
        kind: 'tool',
        call: { tool: 'search', toolCallId: 'tool-1', query: 'atlas' },
        result: {
          tool: 'search',
          toolCallId: 'tool-1',
          query: 'atlas',
          hits: [{ path: 'notes/a.md', title: 'Atlas' }],
        },
        error: null,
      },
      { kind: 'text', text: 'Found it.' },
    ])
  })

  it('tracks a read from pending call to settled result', () => {
    const pending = fold([
      { type: 'tool-call', call: { tool: 'read', toolCallId: 'tool-2', path: 'notes/a.md' } },
    ])
    expect(pending).toEqual([
      {
        kind: 'tool',
        call: { tool: 'read', toolCallId: 'tool-2', path: 'notes/a.md' },
        result: null,
        error: null,
      },
    ])

    const settled = appendEvent(pending, {
      type: 'tool-result',
      result: { tool: 'read', toolCallId: 'tool-2', path: 'notes/a.md', title: 'Atlas', error: null },
    })
    expect(settled[0]).toMatchObject({
      kind: 'tool',
      result: { tool: 'read', title: 'Atlas', error: null },
    })
  })

  it('a tool error settles the in-flight call with its failure and a notice', () => {
    const parts = fold([
      { type: 'tool-call', call: { tool: 'read', toolCallId: 'tool-4', path: 'notes/a.md' } },
      { type: 'tool-error', toolCallId: 'tool-4', message: 'file unreadable' },
    ])
    expect(parts).toEqual([
      {
        kind: 'tool',
        call: { tool: 'read', toolCallId: 'tool-4', path: 'notes/a.md' },
        result: null,
        error: 'file unreadable',
      },
      { kind: 'notice', tone: 'error', text: 'file unreadable' },
    ])
  })

  it('abort and error become notices; complete changes nothing', () => {
    const aborted = fold([
      { type: 'text-delta', text: 'Half…' },
      { type: 'aborted', messages: [] },
    ])
    expect(aborted.at(-1)).toEqual({ kind: 'notice', tone: 'info', text: 'Stopped.' })

    const errored = fold([{ type: 'error', message: 'auth failed', messages: [] }])
    expect(errored).toEqual([{ kind: 'notice', tone: 'error', text: 'auth failed' }])

    expect(appendEvent(errored, { type: 'complete', messages: [] })).toEqual(errored)
  })
})

describe('buildHistory', () => {
  it('derives the model history from settled turns, tool messages included', () => {
    const turns: ChatTurn[] = [
      {
        id: 'turn-1',
        userText: 'where is the plan?',
        parts: [],
        responseMessages: [
          { role: 'assistant', content: 'In [[Atlas]].' },
        ],
        status: 'done',
      },
      {
        id: 'turn-2',
        userText: 'thanks',
        parts: [],
        responseMessages: [],
        status: 'streaming',
      },
    ]
    expect(buildHistory(turns)).toEqual([
      { role: 'user', content: 'where is the plan?' },
      { role: 'assistant', content: 'In [[Atlas]].' },
      { role: 'user', content: 'thanks' },
    ])
  })
})
