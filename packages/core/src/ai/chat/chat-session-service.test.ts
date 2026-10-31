import { describe, expect, it, vi } from 'vitest'
import { createGraphSession } from '../../graph/graph-session.ts'
import type { EmbedStatus } from '../../embeddings/embedding-runtime-service.ts'
import type { GraphInfo } from '../../graph/schemas.ts'
import type { AiProviderConfig, Settings } from '../../settings/schema.ts'
import {
  createTestAiKeyValidationService,
  createTestChatEngineService,
  createTestChatGraphContextService,
  createTestChatHistoryService,
  createTestClockService,
  createTestEmbeddingRuntimeService,
  createTestIdService,
  createTestImageCodec,
  createTestLoggerService,
  createTestSecretStoreService,
  createTestSettingsService,
  type TestChatConversation,
} from '../../testing/index.ts'
import { aiKeySecretName, createAiCredentialService } from '../ai-credential-service.ts'
import { createAiProviderConfigService } from '../ai-provider-config-service.ts'
import type { ChatStreamEvent } from './chat-engine-service.ts'
import type { ChatConversation, ChatHistoryService } from './chat-history-service.ts'
import {
  CHAT_IDLE_CUTOFF_MS,
  conversationTitle,
  createChatSessionService,
} from './chat-session-service.ts'
import { NO_REPLY_NOTICE, type ChatTurn } from './transcript.ts'

/**
 * The session's lifecycle over in-memory services: resuming the latest
 * conversation (and not resuming a stale one), the send/settle save pair,
 * conversation switching, the deleted-conversation guard, and which index
 * generation the writes carry.
 */

const NOW = 1_800_000_000_000

const MODEL: AiProviderConfig = { id: 'm1', provider: 'openai', model: 'gpt-5.4', keyHint: '12345' }

const GRAPH: GraphInfo = { root: '/g', name: 'test-graph', generation: 1 }

const RESTORED_TURN: ChatTurn = {
  id: 'turn-old',
  userText: 'what did I write yesterday?',
  attachments: [],
  parts: [{ kind: 'text', text: 'Three notes.' }],
  responseMessages: [{ role: 'assistant', content: 'Three notes.' }],
  status: 'done',
}

function conversation(overrides: Partial<ChatConversation> = {}): ChatConversation {
  return {
    id: 'conv-1',
    title: 'what did I write yesterday?',
    createdMs: 1,
    updatedMs: NOW,
    ...overrides,
  }
}

function stored(overrides: Partial<ChatConversation> = {}): TestChatConversation {
  return { conversation: conversation(overrides), turns: [RESTORED_TURN] }
}

const REPLY: ChatStreamEvent[] = [
  { type: 'complete', messages: [{ role: 'assistant', content: 'Hi.' }] },
]

function overrideHistory(
  history: ChatHistoryService,
  overrides: Partial<ChatHistoryService>,
): ChatHistoryService {
  return {
    saveTurn: overrides.saveTurn ?? ((input) => history.saveTurn(input)),
    deleteConversation:
      overrides.deleteConversation ??
      ((id, generation) => history.deleteConversation(id, generation)),
    listRecent: overrides.listRecent ?? ((limit) => history.listRecent(limit)),
    loadConversation:
      overrides.loadConversation ?? ((conversationId) => history.loadConversation(conversationId)),
  }
}

interface SetupOptions {
  conversations?: readonly TestChatConversation[]
  settings?: Partial<Settings>
  embedStatus?: EmbedStatus
  /**
   * Wraps the in-memory history, to gate or count its calls.
   */
  history?: (history: ChatHistoryService) => ChatHistoryService
  /**
   * The index generation of the open graph; 7 by default.
   */
  indexGeneration?: number | null
  apiKey?: string | null
}

async function setup(options: SetupOptions = {}) {
  const settings = createTestSettingsService({
    aiProviders: [MODEL],
    defaultAiProviderId: 'm1',
    ...options.settings,
  })
  await settings.whenLoaded()
  const apiKey = options.apiKey === undefined ? 'sk-test' : options.apiKey
  const credentials = createAiCredentialService({
    secretStore: createTestSecretStoreService(
      apiKey === null ? {} : { [aiKeySecretName(MODEL.id)]: apiKey },
    ),
  })
  const id = createTestIdService()
  const chatHistory = createTestChatHistoryService(
    options.conversations === undefined ? {} : { conversations: options.conversations },
  )
  const chatEngine = createTestChatEngineService(REPLY)
  const chatGraphContext = createTestChatGraphContextService()
  const embeddingRuntime = createTestEmbeddingRuntimeService(
    options.embedStatus === undefined ? {} : { status: options.embedStatus },
  )
  const logger = createTestLoggerService()
  const clock = createTestClockService({ now: NOW, today: '2026-10-13' })
  const service = createChatSessionService({
    chatEngine,
    chatHistory: options.history?.(chatHistory) ?? chatHistory,
    chatGraphContext,
    providerConfig: createAiProviderConfigService({
      settings,
      credentials,
      keyValidation: createTestAiKeyValidationService(),
      id,
    }),
    credentials,
    embeddingRuntime,
    settings,
    clock,
    id,
    imageCodec: createTestImageCodec(),
    logger,
  })
  const session = service.create({
    session: createGraphSession({
      ...GRAPH,
      indexGeneration: options.indexGeneration === undefined ? 7 : options.indexGeneration,
    }),
  })
  return {
    service,
    session,
    settings,
    chatHistory,
    chatEngine,
    chatGraphContext,
    embeddingRuntime,
    logger,
    clock,
  }
}

/**
 * Let the started promise chains (a resume, a save) run to their end.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('conversationTitle', () => {
  it('collapses whitespace and cuts the first message to list length', () => {
    expect(conversationTitle('  hello \n there  ')).toBe('hello there')
    expect(conversationTitle('   ')).toBe('New chat')
    expect(conversationTitle('x'.repeat(61))).toBe(`${'x'.repeat(60)}…`)
  })
})

describe('ChatSession persistence', () => {
  it('resumes the latest conversation when it is fresh enough', async () => {
    const { session } = await setup({ conversations: [stored()] })
    session.attach()

    await vi.waitFor(() => expect(session.getState().turns).toEqual([RESTORED_TURN]))
    expect(session.getState().activeConversationId).toBe('conv-1')
  })

  it('starts fresh when the latest conversation idled past the cutoff', async () => {
    let loads = 0
    const { session } = await setup({
      conversations: [stored({ updatedMs: NOW - CHAT_IDLE_CUTOFF_MS - 1 })],
      history: (history) => {
        return overrideHistory(history, {
          loadConversation: async (id) => {
            loads += 1
            return await history.loadConversation(id)
          },
        })
      },
    })
    session.attach()
    await flush()

    expect(loads).toBe(0)
    expect(session.getState().turns).toEqual([])
    expect(session.getState().activeConversationId).not.toBe('conv-1')
  })

  it('does not resume before the session is attached', async () => {
    const { session } = await setup({ conversations: [stored()] })
    await flush()

    expect(session.getState().turns).toEqual([])
  })

  it('saves the user half at send and the settled turn after the stream', async () => {
    const { session, chatHistory, chatEngine } = await setup()
    chatEngine.setScript([{ type: 'text-delta', text: 'Hi.' }, ...REPLY])
    session.attach()
    await flush()

    await session.send('hello there')
    await flush()

    const saves = chatHistory.getSaves()
    expect(saves).toHaveLength(2)
    expect(saves[0]).toMatchObject({
      generation: 7,
      conversation: { id: session.getState().activeConversationId, title: 'hello there' },
      turn: { userText: 'hello there', responseMessages: [], status: 'streaming' },
    })
    expect(saves[1]).toMatchObject({
      turn: {
        status: 'done',
        responseMessages: [{ role: 'assistant', content: 'Hi.' }],
        parts: [{ kind: 'text', text: 'Hi.' }],
      },
    })
    expect(session.getState().status).toBe('idle')
  })

  it('backstops a reply-less turn with a notice, in the state and in the save', async () => {
    // Regression: the forced final step can still yield no text. The session
    // must fold `complete` so a turn that ends on tool activity shows a notice
    // instead of silent chips — and persists it, not a notice-less parts list.
    const { session, chatHistory, chatEngine } = await setup()
    chatEngine.setScript([
      { type: 'tool-call', call: { tool: 'read', toolCallId: 't1', paths: ['notes/a.md'] } },
      {
        type: 'tool-result',
        result: {
          tool: 'read',
          toolCallId: 't1',
          notes: [{ path: 'notes/a.md', title: 'A', error: null }],
        },
      },
      { type: 'complete', messages: [{ role: 'assistant', content: 'noop' }] },
    ])

    await session.send('summarize my notes')
    await flush()

    const notice = { kind: 'notice', tone: 'info', text: NO_REPLY_NOTICE }
    expect(session.getState().turns.at(-1)?.parts.at(-1)).toEqual(notice)
    expect(chatHistory.getSaves().at(-1)?.turn.parts.at(-1)).toEqual(notice)
  })

  it('saves later turns into the restored conversation', async () => {
    const { session, chatHistory } = await setup({ conversations: [stored()] })
    session.attach()
    await vi.waitFor(() => expect(session.getState().turns).toHaveLength(1))

    await session.send('and today?')
    await flush()

    expect(chatHistory.getSaves()[0]).toMatchObject({
      conversation: { id: 'conv-1', title: 'what did I write yesterday?' },
      turn: { userText: 'and today?' },
    })
  })

  it('sends the derived history, the key, and the local date to the engine', async () => {
    const { session, chatEngine, chatGraphContext } = await setup({ conversations: [stored()] })
    session.attach()
    await vi.waitFor(() => expect(session.getState().turns).toHaveLength(1))

    await session.send('and today?')

    expect(chatGraphContext.calls()).toEqual(['test-graph'])
    expect(chatEngine.calls()).toHaveLength(1)
    expect(chatEngine.calls()[0]).toMatchObject({
      config: MODEL,
      apiKey: 'sk-test',
      today: '2026-10-13',
      context: { graphName: 'test-graph' },
      messages: [
        { role: 'user', content: 'what did I write yesterday?' },
        { role: 'assistant', content: 'Three notes.' },
        { role: 'user', content: 'and today?' },
      ],
    })
  })

  it('passes the semantic search setting into chat turns', async () => {
    const { session, chatEngine } = await setup({
      settings: { semanticSearchEnabled: true },
      embedStatus: { status: 'ready', model: 'all-MiniLM-L6-v2' },
    })
    session.attach()
    await flush()

    await session.send('hello')

    expect(chatEngine.calls()[0]?.semanticSearchEnabled).toBe(true)
  })

  it.each<EmbedStatus>([
    { status: 'unsupported' },
    { status: 'uninitialized' },
    { status: 'loading' },
    { status: 'failed', message: 'offline' },
  ])(
    'forces lexical search while the runtime is $status, over an enabled setting',
    async (embedStatus) => {
      const { session, chatEngine } = await setup({
        settings: { semanticSearchEnabled: true },
        embedStatus,
      })
      session.attach()
      await flush()

      await session.send('hello')

      expect(chatEngine.calls()[0]?.semanticSearchEnabled).toBe(false)
    },
  )

  it('passes the latest configured system prompt into the next chat turn', async () => {
    const { session, chatEngine, settings } = await setup()
    settings.update({ chatSystemPrompt: 'Answer like a rigorous research partner.' })

    await session.send('hello')

    expect(chatEngine.calls()[0]?.customSystemPrompt).toBe(
      'Answer like a rigorous research partner.',
    )
  })

  it('holds the composer draft and clears it when a send goes through', async () => {
    const { session } = await setup()

    session.setDraft('half-typed question')
    expect(session.getState().draft).toBe('half-typed question')

    await session.send('half-typed question')
    expect(session.getState().draft).toBe('')
    expect(session.getState().turns.at(-1)?.userText).toBe('half-typed question')
  })

  it('rejects a second send while the first one is in flight', async () => {
    const { session, chatEngine } = await setup()

    await Promise.all([session.send('one'), session.send('two')])

    expect(chatEngine.calls()).toHaveLength(1)
    expect(session.getState().turns.map((turn) => turn.userText)).toEqual(['one'])
  })

  it('surfaces a missing key as an error notice, without a provider call', async () => {
    const { session, chatEngine } = await setup({ apiKey: null })

    await session.send('hello')

    expect(chatEngine.calls()).toEqual([])
    expect(session.getState().turns.at(-1)).toMatchObject({
      status: 'done',
      parts: [{ kind: 'notice', tone: 'error' }],
    })
  })

  it('still sends the turn, without an overview, when the context load fails', async () => {
    const { session, chatEngine, chatGraphContext, logger } = await setup()
    chatGraphContext.setResult(() => {
      throw new Error('index not open')
    })

    await session.send('hello')

    expect(chatEngine.calls()[0]?.context).toBeNull()
    expect(logger.getErrors()).toEqual([
      { message: 'chat graph context failed:', cause: 'index not open' },
    ])
  })

  it('opens a past conversation and switches the active id', async () => {
    const { session } = await setup({ conversations: [stored({ id: 'conv-9', updatedMs: 1 })] })

    await session.openConversation('conv-9')

    expect(session.getState().activeConversationId).toBe('conv-9')
    expect(session.getState().turns).toEqual([RESTORED_TURN])
  })

  it('abandons a switch when a send settled while the rows loaded', async () => {
    // The send both starts AND finishes during the load — the in-flight slot
    // is already clear when the rows arrive, but the switch must still be
    // abandoned: swapping the transcript would hide the turn the user just
    // streamed into the on-screen conversation.
    const pendingLoad = Promise.withResolvers<ChatTurn[]>()
    const { session } = await setup({
      history: (history) => {
        return overrideHistory(history, { loadConversation: () => pendingLoad.promise })
      },
    })
    const homeConversation = session.getState().activeConversationId

    const openDone = session.openConversation('conv-9')
    await session.send('hello')
    expect(session.getState().turns.at(-1)?.status).toBe('done')

    pendingLoad.resolve([RESTORED_TURN])
    await openDone

    expect(session.getState().activeConversationId).toBe(homeConversation)
    expect(session.getState().turns.map((turn) => turn.userText)).toEqual(['hello'])
  })

  it('deleting the active conversation starts a fresh chat', async () => {
    const { session, chatHistory } = await setup({ conversations: [stored()] })
    session.attach()
    await vi.waitFor(() => expect(session.getState().activeConversationId).toBe('conv-1'))

    await session.deleteConversation('conv-1')

    expect(chatHistory.getDeletes()).toEqual(['conv-1'])
    expect(session.getState().turns).toEqual([])
    expect(session.getState().activeConversationId).not.toBe('conv-1')
  })

  it('never saves into a conversation deleted mid-stream', async () => {
    const gate = Promise.withResolvers<void>()
    const { session, chatHistory, chatEngine } = await setup()
    chatEngine.setScript(async function* () {
      yield { type: 'text-delta', text: 'Half…' }
      await gate.promise
      yield { type: 'complete', messages: [{ role: 'assistant', content: 'Done.' }] }
    })

    const sendDone = session.send('hello')
    await flush()
    const sentInto = chatHistory.getSaves()[0]?.conversation.id
    if (sentInto === undefined) {
      expect.unreachable('the user half was not saved')
    }

    // Delete the conversation while the turn is streaming, then let it settle:
    // the settle-time save must not resurrect the deleted row.
    await session.deleteConversation(sentInto)
    gate.resolve()
    await sendDone
    await flush()

    expect(chatHistory.getSaves()).toHaveLength(1)
    expect(await chatHistory.listRecent()).toEqual([])
  })

  it('lets an in-flight save land before deleting its conversation', async () => {
    // The delete and a dispatched save are independent IPC commands with no
    // ordering guarantee — the session must hold the delete until the
    // conversation's save chain settles, or the upsert could resurrect it.
    const pendingSave = Promise.withResolvers<void>()
    const { session, chatHistory } = await setup({
      history: (history) => {
        return overrideHistory(history, {
          saveTurn: async (input) => {
            await pendingSave.promise
            await history.saveTurn(input)
          },
        })
      },
    })

    await session.send('hello')
    const sentInto = session.getState().activeConversationId

    const deleteDone = session.deleteConversation(sentInto)
    await flush()
    expect(chatHistory.getDeletes()).toEqual([])

    pendingSave.resolve()
    await deleteDone
    expect(chatHistory.getDeletes()).toEqual([sentInto])
  })

  it('logs a failed save and keeps the conversation in memory', async () => {
    const { session, logger } = await setup({
      history: (history) => {
        return overrideHistory(history, {
          saveTurn: () => Promise.reject(new Error('disk full')),
        })
      },
    })

    await session.send('hello')
    await flush()

    expect(session.getState().turns.map((turn) => turn.userText)).toEqual(['hello'])
    expect(logger.getErrors()).toContainEqual({
      message: 'chat: saving the turn failed:',
      cause: 'disk full',
    })
  })

  it('reports a changed conversation list after each save and each delete', async () => {
    const { service, session } = await setup()
    let changes = 0
    const stop = service.onConversationsChanged(() => {
      changes += 1
    })

    await session.send('hello')
    await flush()
    expect(changes).toBe(2)

    await session.deleteConversation(session.getState().activeConversationId)
    expect(changes).toBe(3)

    stop()
    await session.send('again')
    await flush()
    expect(changes).toBe(3)
  })
})

describe('ChatSession graph binding', () => {
  it('writes nothing while the graph has no index session', async () => {
    const { session, chatHistory } = await setup({ indexGeneration: null })
    session.attach()

    await session.send('hello')
    await flush()
    await session.deleteConversation(session.getState().activeConversationId)

    expect(chatHistory.getSaves()).toEqual([])
    expect(chatHistory.getDeletes()).toEqual([])
    expect(session.getState().turns).toEqual([])
  })

  it('aborts the in-flight turn when the session detaches', async () => {
    let signal: AbortSignal | undefined
    const { session, chatEngine } = await setup()
    chatEngine.setScript(async function* (request) {
      signal = request.signal
      yield { type: 'text-delta', text: 'Hi' }
      // Never settles — the turn only ends through the abort signal.
      await new Promise<never>(() => {})
    })
    const detach = session.attach()

    void session.send('hey')
    await vi.waitFor(() => expect(signal).toBeDefined())
    expect(signal?.aborted).toBe(false)

    detach()
    expect(signal?.aborted).toBe(true)
  })
})

describe('ChatSession state', () => {
  it('publishes one stable state object until something changes', async () => {
    const { session } = await setup()
    let notified = 0
    const stop = session.subscribe(() => {
      notified += 1
    })

    const first = session.getState()
    expect(session.getState()).toBe(first)

    session.setDraft('hi')
    expect(notified).toBe(1)
    expect(session.getState()).not.toBe(first)
    expect(session.getState().draft).toBe('hi')
    stop()
  })

  it('starts on the persisted model selection', async () => {
    const { session } = await setup({
      settings: { chatModelSelection: { configId: 'm1', modelId: 'gpt-5.5' } },
    })

    expect(session.getState().activeModel).toEqual({ ...MODEL, model: 'gpt-5.5' })
    expect(session.getState().providers).toEqual([MODEL])
    expect(session.getState().modelOptions.map((option) => option.configId)).toContain('m1')
  })

  it('persists a picked model and applies it to the session', async () => {
    const { session, settings } = await setup()
    let notified = 0
    session.subscribe(() => {
      notified += 1
    })
    expect(session.getState().activeModel).toEqual(MODEL)

    session.selectModel({ configId: 'm1', modelId: 'gpt-5.5' })

    expect(settings.get().chatModelSelection).toEqual({ configId: 'm1', modelId: 'gpt-5.5' })
    expect(notified).toBe(1)
    expect(session.getState().activeModel).toEqual({ ...MODEL, model: 'gpt-5.5' })
  })

  it('falls back to the default model when the persisted selection dangles', async () => {
    const { session } = await setup({
      settings: { chatModelSelection: { configId: 'gone', modelId: 'gpt-5.5' } },
    })

    expect(session.getState().activeModel).toEqual(MODEL)
  })

  it('queues image attachments and drops a removed one', async () => {
    const { session } = await setup()

    await session.attachImages([
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'cat.png', { type: 'image/png' }),
    ])
    const [attachment] = session.getState().attachments
    expect(attachment).toMatchObject({
      name: 'cat.png',
      mediaType: 'image/png',
      dataUrl: 'data:image/png;base64,iVBORw==',
    })

    session.removeAttachment(attachment?.id ?? '')
    expect(session.getState().attachments).toEqual([])
  })
})
