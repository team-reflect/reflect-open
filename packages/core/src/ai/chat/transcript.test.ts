import { describe, expect, it } from 'vitest'
import type { ChatStreamEvent } from './stream-chat'
import {
  appendEvent,
  buildHistory,
  buildPrivacySafeHistory,
  mergeSourceProvenance,
  NO_REPLY_NOTICE,
  sourceProvenanceForParts,
  userMessage,
  type AssistantPart,
  type ChatAttachment,
  type ChatTurn,
} from './transcript'

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
          sourceProvenance: [{ kind: 'note', path: 'notes/a.md' }],
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
          sourceProvenance: [{ kind: 'note', path: 'notes/a.md' }],
        },
        error: null,
      },
      { kind: 'text', text: 'Found it.' },
    ])
  })

  it('tracks a read from pending call to settled result', () => {
    const pending = fold([
      { type: 'tool-call', call: { tool: 'read', toolCallId: 'tool-2', paths: ['notes/a.md'] } },
    ])
    expect(pending).toEqual([
      {
        kind: 'tool',
        call: { tool: 'read', toolCallId: 'tool-2', paths: ['notes/a.md'] },
        result: null,
        error: null,
      },
    ])

    const settled = appendEvent(pending, {
      type: 'tool-result',
      result: {
        tool: 'read',
        toolCallId: 'tool-2',
        notes: [{ path: 'notes/a.md', title: 'Atlas', error: null }],
      },
    })
    expect(settled[0]).toMatchObject({
      kind: 'tool',
      result: { tool: 'read', notes: [{ path: 'notes/a.md', title: 'Atlas', error: null }] },
    })
  })

  it('a tool error settles the in-flight call with its failure and a notice', () => {
    const parts = fold([
      { type: 'tool-call', call: { tool: 'read', toolCallId: 'tool-4', paths: ['notes/a.md'] } },
      { type: 'tool-error', toolCallId: 'tool-4', message: 'file unreadable' },
    ])
    expect(parts).toEqual([
      {
        kind: 'tool',
        call: { tool: 'read', toolCallId: 'tool-4', paths: ['notes/a.md'] },
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

  it('a turn that completes with only tool activity gets a reply notice', () => {
    // The step-ceiling dead end: tools ran, the model never synthesized, and
    // the turn settles. The user must see a notice, not silent tool chips.
    const parts = fold([
      { type: 'tool-call', call: { tool: 'read', toolCallId: 'tool-7', paths: ['notes/a.md'] } },
      {
        type: 'tool-result',
        result: {
          tool: 'read',
          toolCallId: 'tool-7',
          notes: [{ path: 'notes/a.md', title: 'Atlas', error: null }],
        },
      },
      { type: 'complete', messages: [] },
    ])
    expect(parts.at(-1)).toEqual({ kind: 'notice', tone: 'info', text: NO_REPLY_NOTICE })
  })

  it('complete adds no notice once the turn has answered', () => {
    const parts = fold([
      { type: 'text-delta', text: 'Here it is.' },
      { type: 'complete', messages: [] },
    ])
    expect(parts).toEqual([{ kind: 'text', text: 'Here it is.' }])
  })

  it('a terminal event settles tool calls still in flight — no eternal spinners', () => {
    const aborted = fold([
      { type: 'tool-call', call: { tool: 'read', toolCallId: 'tool-5', paths: ['notes/a.md'] } },
      { type: 'aborted', messages: [] },
    ])
    expect(aborted[0]).toMatchObject({ kind: 'tool', result: null, error: 'Stopped.' })

    const errored = fold([
      { type: 'tool-call', call: { tool: 'search', toolCallId: 'tool-6', query: 'atlas' } },
      { type: 'error', message: 'connection lost', messages: [] },
    ])
    expect(errored[0]).toMatchObject({ kind: 'tool', result: null, error: 'connection lost' })
  })
})

describe('buildHistory', () => {
  it('derives the model history from settled turns, tool messages included', () => {
    const turns: ChatTurn[] = [
      {
        id: 'turn-1',
        permissionMode: 'read',
        userText: 'where is the plan?',
        attachments: [],
        parts: [],
        responseMessages: [{ role: 'assistant', content: 'In [[Atlas]].' }],
        sourceProvenance: [],
        status: 'done',
      },
      {
        id: 'turn-2',
        permissionMode: 'read',
        userText: 'and the budget?',
        attachments: [],
        parts: [],
        responseMessages: [{ role: 'assistant', content: 'In [[Q3 Budget]].' }],
        sourceProvenance: [],
        status: 'done',
      },
    ]
    expect(buildHistory(turns)).toEqual([
      { role: 'user', content: 'where is the plan?' },
      { role: 'assistant', content: 'In [[Atlas]].' },
      { role: 'user', content: 'and the budget?' },
      { role: 'assistant', content: 'In [[Q3 Budget]].' },
    ])
  })

  it('omits turns that produced nothing — no dangling user messages', () => {
    const turns: ChatTurn[] = [
      {
        id: 'turn-1',
        permissionMode: 'read',
        // Failed before the provider replied (e.g. missing API key): the
        // transcript shows the error, the model history never saw it.
        userText: 'this one failed',
        attachments: [],
        parts: [{ kind: 'notice', tone: 'error', text: 'No API key found' }],
        responseMessages: [],
        sourceProvenance: [],
        status: 'done',
      },
      {
        id: 'turn-2',
        permissionMode: 'read',
        userText: 'this one worked',
        attachments: [],
        parts: [],
        responseMessages: [{ role: 'assistant', content: 'Answer.' }],
        sourceProvenance: [],
        status: 'done',
      },
    ]
    expect(buildHistory(turns)).toEqual([
      { role: 'user', content: 'this one worked' },
      { role: 'assistant', content: 'Answer.' },
    ])
  })

  it('resends attached images as image parts, text part only when present', () => {
    const photo: ChatAttachment = {
      id: 'att-1',
      name: 'cat.png',
      mediaType: 'image/png',
      dataUrl: 'data:image/png;base64,iVBORw==',
    }
    const turns: ChatTurn[] = [
      {
        id: 'turn-1',
        permissionMode: 'read',
        userText: '',
        attachments: [photo],
        parts: [],
        responseMessages: [{ role: 'assistant', content: 'A cat.' }],
        sourceProvenance: [],
        status: 'done',
      },
    ]
    expect(buildHistory(turns)).toEqual([
      {
        role: 'user',
        content: [{ type: 'file', data: photo.dataUrl, mediaType: 'image/png' }],
      },
      { role: 'assistant', content: 'A cat.' },
    ])
  })
})

describe('buildPrivacySafeHistory', () => {
  function turn(
    id: string,
    sourceProvenance: ChatTurn['sourceProvenance'],
    parts: AssistantPart[] = [],
  ): ChatTurn {
    return {
      id,
      permissionMode: 'read',
      userText: `question ${id}`,
      attachments: [],
      parts,
      responseMessages: [{ role: 'assistant', content: `answer ${id}` }],
      sourceProvenance,
      status: 'done',
    }
  }

  it('drops the contaminated turn and every later turn from outbound history', async () => {
    const turns = [
      turn('one', [{ kind: 'note', path: 'notes/public.md' }]),
      turn('two', [{ kind: 'note', path: 'notes/private.md' }]),
      turn('three', []),
    ]
    const history = await buildPrivacySafeHistory(
      turns,
      async (source) => source.path !== 'notes/private.md',
    )
    expect(history).toEqual([
      { role: 'user', content: 'question one' },
      { role: 'assistant', content: 'answer one' },
    ])
  })

  it('fails closed on an unclassifiable legacy turn or validator error', async () => {
    expect(
      await buildPrivacySafeHistory([turn('legacy', null), turn('later', [])], async () => true),
    ).toEqual([])
    expect(
      await buildPrivacySafeHistory(
        [turn('error', [{ kind: 'asset', path: 'assets/a.png' }])],
        async () => {
          throw new Error('disk unavailable')
        },
      ),
    ).toEqual([])
  })

  it('merges successful tool result provenance without duplicates', () => {
    expect(
      mergeSourceProvenance([{ kind: 'note', path: 'notes/a.md' }], {
        tool: 'read',
        toolCallId: 'read-1',
        notes: [
          { path: 'notes/a.md', title: 'A', error: null },
          { path: 'notes/b.md', title: 'B', error: null },
          { path: 'notes/private.md', title: null, error: 'private' },
        ],
      }),
    ).toEqual([
      { kind: 'note', path: 'notes/a.md' },
      { kind: 'note', path: 'notes/b.md' },
    ])
    expect(
      mergeSourceProvenance([], {
        tool: 'search',
        toolCallId: 'search-1',
        query: 'chart',
        hits: [{ path: 'notes/a.md', title: 'A' }],
        sourceProvenance: [
          { kind: 'note', path: 'notes/a.md' },
          { kind: 'asset', path: 'assets/chart.png' },
        ],
      }),
    ).toEqual([
      { kind: 'note', path: 'notes/a.md' },
      { kind: 'asset', path: 'assets/chart.png' },
    ])
    expect(
      mergeSourceProvenance([], {
        tool: 'search',
        toolCallId: 'legacy-search',
        query: 'chart',
        hits: [],
        sourceProvenance: null,
      }),
    ).toBeNull()
  })

  it('classifies an unrepresented legacy tool call as unknown provenance', () => {
    expect(
      sourceProvenanceForParts(
        [],
        [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'legacy-call',
                toolName: 'removed_tool',
                input: {},
              },
            ],
          },
        ],
      ),
    ).toBeNull()
  })

  it('treats a model tool result with only a call chip as unknown provenance', () => {
    expect(
      sourceProvenanceForParts(
        [
          {
            kind: 'tool',
            call: { tool: 'read', toolCallId: 'legacy-read', paths: ['notes/a.md'] },
            result: null,
            error: null,
          },
        ],
        [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'legacy-read',
                toolName: 'read_notes',
                input: { paths: ['notes/a.md'] },
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'legacy-read',
                toolName: 'read_notes',
                output: {
                  type: 'json',
                  value: { notes: [{ path: 'notes/a.md', content: 'legacy note bytes' }] },
                },
              },
            ],
          },
        ],
      ),
    ).toBeNull()
  })
})

describe('userMessage', () => {
  const photo: ChatAttachment = {
    id: 'att-1',
    name: 'cat.png',
    mediaType: 'image/png',
    dataUrl: 'data:image/png;base64,iVBORw==',
  }

  it('is plain text when nothing is attached', () => {
    expect(userMessage('hello', [])).toEqual({ role: 'user', content: 'hello' })
  })

  it('puts images before the text', () => {
    expect(userMessage('what is this?', [photo])).toEqual({
      role: 'user',
      content: [
        { type: 'file', data: photo.dataUrl, mediaType: 'image/png' },
        { type: 'text', text: 'what is this?' },
      ],
    })
  })

  it('omits the text part for a photo-only message', () => {
    expect(userMessage('', [photo])).toEqual({
      role: 'user',
      content: [{ type: 'file', data: photo.dataUrl, mediaType: 'image/png' }],
    })
  })
})
