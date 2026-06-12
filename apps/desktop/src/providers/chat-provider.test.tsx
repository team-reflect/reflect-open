import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type {
  AiProviderConfig,
  ChatConversation,
  ChatStreamEvent,
  ChatTurn,
  GraphInfo,
  StreamChatOptions,
} from '@reflect/core'
import { ChatProvider, useChatSession } from '@/providers/chat-provider'

/**
 * The provider's persistence lifecycle over a fully scripted store: resuming
 * the latest conversation (and not resuming a stale one), the send/settle
 * save pair, conversation switching, and the deleted-conversation guard.
 * The engine (`streamChat`) and the store functions are mocks — the Rust
 * round-trip is covered by the store and `db` tests.
 */

const core = vi.hoisted(() => ({
  streamChat: vi.fn<(options: StreamChatOptions) => AsyncGenerator<ChatStreamEvent>>(),
  getSecret: vi.fn<(name: string) => Promise<string | null>>(),
  hasBridge: vi.fn<() => boolean>(),
  loadChatGraphContext: vi.fn<(graphName: string) => Promise<null>>(),
  listChatConversations: vi.fn<(limit?: number) => Promise<ChatConversation[]>>(),
  loadChatMessages: vi.fn<(id: string) => Promise<ChatTurn[]>>(),
  saveChatMessage: vi.fn<(input: unknown) => Promise<void>>(),
  deleteChatConversation: vi.fn<(id: string, generation: number) => Promise<void>>(),
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  ...core,
}))

const settingsState = vi.hoisted(() => ({
  models: [] as AiProviderConfig[],
  defaultId: null as string | null,
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: { aiProviders: settingsState.models, defaultAiProviderId: settingsState.defaultId },
    updateSettings: () => {},
  }),
}))

vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ indexGeneration: 7, graph: { root: '/g' } }),
}))

vi.mock('@/lib/provider-fetch', () => ({ providerFetch: vi.fn() }))

const MODEL: AiProviderConfig = { id: 'm1', provider: 'openai', model: 'gpt-5.4', keyHint: '12345' }

const RESTORED_TURN: ChatTurn = {
  id: 'turn-old',
  userText: 'what did I write yesterday?',
  attachments: [],
  parts: [{ kind: 'text', text: 'Three notes.' }],
  responseMessages: [{ role: 'assistant', content: 'Three notes.' }],
  status: 'done',
}

function conversation(overrides: Partial<ChatConversation> = {}): ChatConversation {
  return { id: 'conv-1', title: 'what did I write yesterday?', createdMs: 1, updatedMs: Date.now(), ...overrides }
}

let session: ReturnType<typeof useChatSession> | null = null

function Probe(): ReactElement | null {
  session = useChatSession()
  return null
}

const GRAPH: GraphInfo = { root: '/g', name: 'test-graph', cloudSync: null, generation: 1 }

function renderProvider() {
  session = null
  return render(
    <ChatProvider graph={GRAPH}>
      <Probe />
    </ChatProvider>,
  )
}

function scriptTurn(events: ChatStreamEvent[]) {
  core.streamChat.mockImplementation(function script() {
    return (async function* () {
      yield* events
    })()
  })
}

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  settingsState.models = [MODEL]
  settingsState.defaultId = 'm1'
  core.hasBridge.mockReturnValue(true)
  core.getSecret.mockResolvedValue('sk-test')
  core.loadChatGraphContext.mockResolvedValue(null)
  core.listChatConversations.mockResolvedValue([])
  core.loadChatMessages.mockResolvedValue([RESTORED_TURN])
  core.saveChatMessage.mockResolvedValue(undefined)
  core.deleteChatConversation.mockResolvedValue(undefined)
})

describe('ChatProvider persistence', () => {
  it('resumes the latest conversation when it is fresh enough', async () => {
    core.listChatConversations.mockResolvedValue([conversation()])
    renderProvider()

    await waitFor(() => expect(session?.turns).toEqual([RESTORED_TURN]))
    expect(session?.activeConversationId).toBe('conv-1')
    expect(core.loadChatMessages).toHaveBeenCalledWith('conv-1')
  })

  it('starts fresh when the latest conversation idled past the cutoff', async () => {
    core.listChatConversations.mockResolvedValue([
      conversation({ updatedMs: Date.now() - 7 * 60 * 60 * 1000 }),
    ])
    renderProvider()

    await waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())
    expect(core.loadChatMessages).not.toHaveBeenCalled()
    expect(session?.turns).toEqual([])
    expect(session?.activeConversationId).not.toBe('conv-1')
  })

  it('saves the user half at send and the settled turn after the stream', async () => {
    scriptTurn([
      { type: 'text-delta', text: 'Hi.' },
      { type: 'complete', messages: [{ role: 'assistant', content: 'Hi.' }] },
    ])
    renderProvider()
    await waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

    await act(() => session?.send('hello there'))

    expect(core.saveChatMessage).toHaveBeenCalledTimes(2)
    const first = core.saveChatMessage.mock.calls[0][0]
    const second = core.saveChatMessage.mock.calls[1][0]
    expect(first).toMatchObject({
      seq: 0,
      generation: 7,
      conversation: { id: session?.activeConversationId, title: 'hello there' },
      turn: { userText: 'hello there', responseMessages: [] },
    })
    expect(second).toMatchObject({
      seq: 0,
      turn: {
        status: 'done',
        responseMessages: [{ role: 'assistant', content: 'Hi.' }],
        parts: [{ kind: 'text', text: 'Hi.' }],
      },
    })
  })

  it('numbers turns after restored history', async () => {
    core.listChatConversations.mockResolvedValue([conversation()])
    scriptTurn([{ type: 'complete', messages: [{ role: 'assistant', content: 'More.' }] }])
    renderProvider()
    await waitFor(() => expect(session?.turns).toHaveLength(1))

    await act(() => session?.send('and today?'))

    expect(core.saveChatMessage.mock.calls[0][0]).toMatchObject({
      seq: 1,
      conversation: { id: 'conv-1', title: 'what did I write yesterday?' },
    })
  })

  it('opens a past conversation and switches the active id', async () => {
    renderProvider()
    await waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

    await act(() => session?.openConversation('conv-9'))

    expect(core.loadChatMessages).toHaveBeenCalledWith('conv-9')
    expect(session?.activeConversationId).toBe('conv-9')
    expect(session?.turns).toEqual([RESTORED_TURN])
  })

  it('deleting the active conversation starts a fresh chat', async () => {
    core.listChatConversations.mockResolvedValue([conversation()])
    renderProvider()
    await waitFor(() => expect(session?.activeConversationId).toBe('conv-1'))

    await act(() => session?.deleteConversation('conv-1'))

    expect(core.deleteChatConversation).toHaveBeenCalledWith('conv-1', 7)
    expect(session?.turns).toEqual([])
    expect(session?.activeConversationId).not.toBe('conv-1')
  })

  it('never saves into a conversation deleted mid-stream', async () => {
    let releaseStream: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    core.streamChat.mockImplementation(function script() {
      return (async function* () {
        yield { type: 'text-delta', text: 'Half…' } satisfies ChatStreamEvent
        await gate
        yield {
          type: 'complete',
          messages: [{ role: 'assistant', content: 'Done.' }],
        } satisfies ChatStreamEvent
      })()
    })
    renderProvider()
    await waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

    let sendDone: Promise<void> | undefined
    await act(async () => {
      sendDone = session?.send('hello')
      await Promise.resolve()
    })
    const sentInto = core.saveChatMessage.mock.calls[0][0] as { conversation: { id: string } }

    // Delete the conversation while the turn is streaming, then let it settle:
    // the settle-time save must not resurrect the deleted row.
    await act(() => session?.deleteConversation(sentInto.conversation.id))
    releaseStream()
    await act(async () => {
      await sendDone
    })

    expect(core.saveChatMessage).toHaveBeenCalledTimes(1)
  })
})
