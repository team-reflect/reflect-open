import { describe, expect, it } from 'vitest'
import { createTestChatHistoryService } from '../../testing/chat.ts'
import { createNodeTestDatabaseService } from '../../testing/database.ts'
import { createTestIpcBridgeService } from '../../testing/ipc.ts'
import { createTestLoggerService } from '../../testing/logger.ts'
import { createChatHistoryService } from './chat-history-service.ts'
import type { ChatTurn } from './transcript.ts'

const turn: ChatTurn = {
  id: 'turn-1',
  userText: 'what is this?',
  attachments: [
    {
      id: 'att-1',
      name: 'cat.png',
      mediaType: 'image/png',
      dataUrl: 'data:image/png;base64,iVBORw==',
    },
  ],
  parts: [
    {
      kind: 'tool',
      call: { tool: 'search', toolCallId: 'tool-1', query: 'cat' },
      result: {
        tool: 'search',
        toolCallId: 'tool-1',
        query: 'cat',
        hits: [{ path: 'notes/a.md', title: 'Cats' }],
      },
      error: null,
    },
    { kind: 'text', text: 'A cat, per [[Cats]].' },
    { kind: 'notice', tone: 'info', text: 'Stopped.' },
  ],
  responseMessages: [{ role: 'assistant', content: 'A cat, per [[Cats]].' }],
  status: 'done',
}

const conversation = { id: 'conv-1', title: 'what is this?', createdMs: 1_000, updatedMs: 2_000 }

function setup() {
  const ipc = createTestIpcBridgeService()
  const database = createNodeTestDatabaseService()
  const logger = createTestLoggerService()
  const history = createChatHistoryService({ ipc, database, logger })

  async function insertConversation(row: typeof conversation): Promise<void> {
    await database.runQuery(
      'INSERT INTO chat_conversations(id, title, created_ms, updated_ms) VALUES (?, ?, ?, ?)',
      [row.id, row.title, row.createdMs, row.updatedMs],
    )
  }

  async function insertMessage(
    seq: number,
    overrides: Partial<Record<'id' | 'parts', string>> = {},
  ): Promise<void> {
    await database.runQuery(
      `INSERT INTO chat_messages(
        id, conversation_id, seq, user_text, attachments, parts, response_messages, created_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        overrides.id ?? turn.id,
        conversation.id,
        seq,
        turn.userText,
        JSON.stringify(turn.attachments),
        overrides.parts ?? JSON.stringify(turn.parts),
        JSON.stringify(turn.responseMessages),
        2_000,
      ],
    )
  }

  return { ipc, database, logger, history, insertConversation, insertMessage }
}

describe('createChatHistoryService', () => {
  it('sends the conversation and the JSON-encoded message row', async () => {
    const { ipc, history } = setup()
    ipc.onCommand('chat_message_save', () => null)
    await history.saveTurn({ conversation, turn, createdMs: 2_000, generation: 7 })

    // No `seq` in the payload: Rust assigns it inside the insert.
    expect(ipc.calls()).toEqual([
      {
        command: 'chat_message_save',
        args: {
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
        },
      },
    ])
  })

  it('deletes a conversation for a generation', async () => {
    const { ipc, history } = setup()
    ipc.onCommand('chat_conversation_delete', () => null)
    await history.deleteConversation('conv-1', 3)
    expect(ipc.calls()).toEqual([
      { command: 'chat_conversation_delete', args: { id: 'conv-1', generation: 3 } },
    ])
  })

  it('lists the most recently active conversations first', async () => {
    const { history, insertConversation } = setup()
    await insertConversation(conversation)
    await insertConversation({ ...conversation, id: 'conv-2', updatedMs: 3_000 })
    await insertConversation({ ...conversation, id: 'conv-3', updatedMs: 1_500 })

    const recent = await history.listRecent()
    expect(recent.map((row) => row.id)).toEqual(['conv-2', 'conv-1', 'conv-3'])
    expect(recent[1]).toEqual(conversation)
    expect((await history.listRecent(1)).map((row) => row.id)).toEqual(['conv-2'])
  })

  it('round-trips a persisted turn in order, restored as done', async () => {
    const { history, insertConversation, insertMessage } = setup()
    await insertConversation(conversation)
    await insertMessage(1, { id: 'turn-2' })
    await insertMessage(0)

    const turns = await history.loadConversation('conv-1')
    expect(turns).toEqual([turn, { ...turn, id: 'turn-2' }])
  })

  it('drops an unreadable row but keeps the rest', async () => {
    const { logger, history, insertConversation, insertMessage } = setup()
    await insertConversation(conversation)
    await insertMessage(0, { id: 'turn-bad', parts: '{not json' })
    await insertMessage(1)

    expect(await history.loadConversation('conv-1')).toEqual([turn])
    expect(logger.getErrors()).toEqual([
      { message: 'dropping unreadable chat message turn-bad in conv-1', cause: undefined },
    ])
  })

  it('drops a row whose parts fail validation', async () => {
    const { history, insertConversation, insertMessage } = setup()
    await insertConversation(conversation)
    await insertMessage(0, { parts: JSON.stringify([{ kind: 'mystery' }]) })
    expect(await history.loadConversation('conv-1')).toEqual([])
  })

  it('upgrades a legacy single-note read part to the batch shape', async () => {
    const { history, insertConversation, insertMessage } = setup()
    // History persisted before read_notes stored read as a single note; it must
    // still load, rewritten to the current paths/notes shape rather than dropped.
    const legacyParts = [
      {
        kind: 'tool',
        call: { tool: 'read', toolCallId: 'tool-2', path: 'notes/a.md' },
        result: {
          tool: 'read',
          toolCallId: 'tool-2',
          path: 'notes/a.md',
          title: 'Cats',
          error: null,
        },
        error: null,
      },
    ]
    await insertConversation(conversation)
    await insertMessage(0, { parts: JSON.stringify(legacyParts) })

    const [restored] = await history.loadConversation('conv-1')
    expect(restored?.parts).toEqual([
      {
        kind: 'tool',
        call: { tool: 'read', toolCallId: 'tool-2', paths: ['notes/a.md'] },
        result: {
          tool: 'read',
          toolCallId: 'tool-2',
          notes: [{ path: 'notes/a.md', title: 'Cats', error: null }],
        },
        error: null,
      },
    ])
  })
})

describe('createTestChatHistoryService', () => {
  it('upserts like the native store', async () => {
    const history = createTestChatHistoryService({
      conversations: [{ conversation, turns: [turn] }],
    })
    const pending: ChatTurn = { ...turn, id: 'turn-2', parts: [], status: 'streaming' }
    const renamed = { ...conversation, title: 'renamed', updatedMs: 5_000 }
    await history.saveTurn({
      conversation: renamed,
      turn: pending,
      createdMs: 5_000,
      generation: 1,
    })
    await history.saveTurn({
      conversation: renamed,
      turn: { ...pending, parts: turn.parts },
      createdMs: 5_000,
      generation: 1,
    })

    expect(await history.listRecent()).toEqual([{ ...conversation, updatedMs: 5_000 }])
    expect(await history.loadConversation('conv-1')).toEqual([
      turn,
      { ...turn, id: 'turn-2', status: 'done' },
    ])
    expect(history.getSaves()).toHaveLength(2)

    await history.deleteConversation('conv-1', 1)
    expect(await history.listRecent()).toEqual([])
    expect(history.getDeletes()).toEqual(['conv-1'])
  })
})
