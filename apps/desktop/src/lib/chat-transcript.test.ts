import { describe, expect, it } from 'vitest'
import type { ChatStreamEvent } from '@reflect/core'
import { appendEvent, type AssistantPart } from './chat-transcript'

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
      { type: 'search-call', toolCallId: 'tool-1', query: 'atlas' },
      {
        type: 'search-result',
        toolCallId: 'tool-1',
        query: 'atlas',
        hits: [{ path: 'notes/a.md', title: 'Atlas' }],
      },
      { type: 'text-delta', text: 'Found it.' },
    ])
    expect(parts).toEqual([
      { kind: 'text', text: 'Looking… ' },
      {
        kind: 'search',
        toolCallId: 'tool-1',
        query: 'atlas',
        hits: [{ path: 'notes/a.md', title: 'Atlas' }],
      },
      { kind: 'text', text: 'Found it.' },
    ])
  })

  it('tracks a read from pending call to settled result', () => {
    const pending = fold([{ type: 'read-call', toolCallId: 'tool-2', path: 'notes/a.md' }])
    expect(pending).toEqual([
      {
        kind: 'read',
        toolCallId: 'tool-2',
        path: 'notes/a.md',
        title: null,
        error: null,
        pending: true,
      },
    ])

    const settled = appendEvent(pending, {
      type: 'read-result',
      toolCallId: 'tool-2',
      path: 'notes/a.md',
      title: 'Atlas',
      error: null,
    })
    expect(settled).toEqual([
      {
        kind: 'read',
        toolCallId: 'tool-2',
        path: 'notes/a.md',
        title: 'Atlas',
        error: null,
        pending: false,
      },
    ])
  })

  it('a tool error settles the in-flight call and surfaces a notice', () => {
    const parts = fold([
      { type: 'search-call', toolCallId: 'tool-3', query: 'atlas' },
      { type: 'tool-error', toolCallId: 'tool-3', message: 'index unavailable' },
    ])
    expect(parts).toEqual([
      { kind: 'search', toolCallId: 'tool-3', query: 'atlas', hits: [] },
      { kind: 'notice', tone: 'error', text: 'index unavailable' },
    ])
  })

  it('a failed read keeps the failure — it must not settle as a clickable success', () => {
    const parts = fold([
      { type: 'read-call', toolCallId: 'tool-4', path: 'notes/a.md' },
      { type: 'tool-error', toolCallId: 'tool-4', message: 'file unreadable' },
    ])
    expect(parts[0]).toEqual({
      kind: 'read',
      toolCallId: 'tool-4',
      path: 'notes/a.md',
      title: null,
      error: 'file unreadable',
      pending: false,
    })
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
