import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../../ipc/bridge'
import { loadChatMessages, saveChatMessage } from './store'
import type { ChatTurn } from './transcript'

/**
 * The store against a scripted bridge: writes assert the exact Rust command
 * payload (the serde contract), reads assert the JSON columns parse back
 * into the same {@link ChatTurn} — and that a corrupt row is dropped, not
 * fatal.
 */

const invoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

beforeEach(() => {
  invoke.mockReset()
  setBridge({ invoke, listen: async () => () => {} })
})

afterEach(() => {
  setBridge(null)
  vi.restoreAllMocks()
})

const turn: ChatTurn = {
  id: 'turn-1',
  userText: 'what is this?',
  attachments: [
    { id: 'att-1', name: 'cat.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw==' },
  ],
  parts: [
    {
      kind: 'tool',
      call: { tool: 'search', toolCallId: 'tool-1', query: 'cat' },
      result: { tool: 'search', toolCallId: 'tool-1', query: 'cat', hits: [{ path: 'notes/a.md', title: 'Cats' }] },
      error: null,
    },
    { kind: 'text', text: 'A cat, per [[Cats]].' },
    { kind: 'notice', tone: 'info', text: 'Stopped.' },
  ],
  responseMessages: [{ role: 'assistant', content: 'A cat, per [[Cats]].' }],
  status: 'done',
}

const conversation = { id: 'conv-1', title: 'what is this?', createdMs: 1_000, updatedMs: 2_000 }

describe('saveChatMessage', () => {
  it('sends the conversation and the JSON-encoded message row', async () => {
    invoke.mockResolvedValue(null)
    await saveChatMessage({ conversation, turn, createdMs: 2_000, generation: 7 })

    // No `seq` in the payload — Rust assigns it inside the insert.
    expect(invoke).toHaveBeenCalledWith('chat_message_save', {
      conversation,
      message: {
        id: 'turn-1',
        conversationId: 'conv-1',
        userText: 'what is this?',
        attachments: JSON.stringify(turn.attachments),
        parts: JSON.stringify(turn.parts),
        responseMessages: JSON.stringify(turn.responseMessages),
        createdMs: 2_000,
      },
      generation: 7,
    })
  })
})

describe('loadChatMessages', () => {
  function messageRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      id: 'turn-1',
      user_text: turn.userText,
      attachments: JSON.stringify(turn.attachments),
      parts: JSON.stringify(turn.parts),
      response_messages: JSON.stringify(turn.responseMessages),
      ...overrides,
    }
  }

  it('round-trips a persisted turn, restored as done', async () => {
    invoke.mockResolvedValue([messageRow()])
    const turns = await loadChatMessages('conv-1')
    expect(turns).toEqual([turn])
    // The query went through the read-only bridge with the conversation bound.
    const [command, args] = invoke.mock.calls[0]!
    expect(command).toBe('db_query')
    expect(args).toMatchObject({ params: ['conv-1'] })
  })

  it('drops an unreadable row but keeps the rest', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    invoke.mockResolvedValue([
      messageRow({ id: 'turn-bad', parts: '{not json' }),
      messageRow(),
    ])
    const turns = await loadChatMessages('conv-1')
    expect(turns).toEqual([turn])
    expect(error).toHaveBeenCalledOnce()
  })

  it('drops a row whose parts fail validation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    invoke.mockResolvedValue([
      messageRow({ parts: JSON.stringify([{ kind: 'mystery' }]) }),
    ])
    expect(await loadChatMessages('conv-1')).toEqual([])
  })
})
