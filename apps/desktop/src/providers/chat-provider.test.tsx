import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type {
  AiProviderConfig,
  ChatConversation,
  ChatModelSelection,
  ChatStreamEvent,
  ChatTurn,
  GraphInfo,
  Settings,
  StreamChatOptions,
} from '@reflect/core'
import { NO_REPLY_NOTICE } from '@reflect/core'
import { setPlatformSurface } from '@/lib/platform-surface'
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
  selection: null as ChatModelSelection | null,
  semanticSearchEnabled: false,
}))
const updateSettings = vi.hoisted(() => vi.fn<(patch: Partial<Settings>) => void>())
// Stateful like the real provider: a chatModelSelection patch re-renders with
// the new value, so selectModel applies instantly here too.
vi.mock('@/providers/settings-provider', async () => {
  const { useState } = await import('react')
  return {
    useSettings: () => {
      const [selection, setSelection] = useState(settingsState.selection)
      return {
        settings: {
          aiProviders: settingsState.models,
          defaultAiProviderId: settingsState.defaultId,
          chatModelSelection: selection,
          semanticSearchEnabled: settingsState.semanticSearchEnabled,
        },
        updateSettings: (patch: Partial<Settings>) => {
          updateSettings(patch)
          if (patch.chatModelSelection !== undefined) {
            setSelection(patch.chatModelSelection)
          }
        },
      }
    },
  }
})

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

const GRAPH: GraphInfo = { root: '/g', name: 'test-graph', generation: 1 }

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
  settingsState.selection = null
  settingsState.semanticSearchEnabled = false
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
    const first = core.saveChatMessage.mock.calls[0]![0]
    const second = core.saveChatMessage.mock.calls[1]![0]
    expect(first).toMatchObject({
      generation: 7,
      conversation: { id: session?.activeConversationId, title: 'hello there' },
      turn: { userText: 'hello there', responseMessages: [] },
    })
    expect(second).toMatchObject({
      turn: {
        status: 'done',
        responseMessages: [{ role: 'assistant', content: 'Hi.' }],
        parts: [{ kind: 'text', text: 'Hi.' }],
      },
    })
  })

  it('backstops a reply-less turn with a notice, on screen and in the save', async () => {
    // Regression: the forced final step can still yield no text. The provider
    // must fold `complete` so a turn that ends on tool activity shows a notice
    // instead of silent chips — and persists it, not a notice-less parts list.
    scriptTurn([
      { type: 'tool-call', call: { tool: 'read', toolCallId: 't1', paths: ['notes/a.md'] } },
      {
        type: 'tool-result',
        result: { tool: 'read', toolCallId: 't1', notes: [{ path: 'notes/a.md', title: 'A', error: null }] },
      },
      { type: 'complete', messages: [{ role: 'assistant', content: 'noop' }] },
    ])
    renderProvider()
    await waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

    await act(() => session?.send('summarize my notes'))

    const notice = { kind: 'notice', tone: 'info', text: NO_REPLY_NOTICE }
    expect(session?.turns.at(-1)?.parts.at(-1)).toEqual(notice)
    const saved = core.saveChatMessage.mock.calls.at(-1)![0] as { turn: ChatTurn }
    expect(saved.turn.parts.at(-1)).toEqual(notice)
  })

  it('saves later turns into the restored conversation', async () => {
    core.listChatConversations.mockResolvedValue([conversation()])
    scriptTurn([{ type: 'complete', messages: [{ role: 'assistant', content: 'More.' }] }])
    renderProvider()
    await waitFor(() => expect(session?.turns).toHaveLength(1))

    await act(() => session?.send('and today?'))

    expect(core.saveChatMessage.mock.calls[0]![0]).toMatchObject({
      conversation: { id: 'conv-1', title: 'what did I write yesterday?' },
      turn: { userText: 'and today?' },
    })
  })

  it('passes the semantic search setting into chat turns', async () => {
    settingsState.semanticSearchEnabled = true
    scriptTurn([{ type: 'complete', messages: [{ role: 'assistant', content: 'Hi.' }] }])
    renderProvider()
    await waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

    await act(() => session?.send('hello'))

    expect(core.streamChat).toHaveBeenCalledWith(
      expect.objectContaining({ semanticSearchEnabled: true }),
    )
  })

  it('forces lexical search on the mobile surface, over an enabled setting', async () => {
    settingsState.semanticSearchEnabled = true
    setPlatformSurface({ mobileApp: true })
    try {
      scriptTurn([{ type: 'complete', messages: [{ role: 'assistant', content: 'Hi.' }] }])
      renderProvider()
      await waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

      await act(() => session?.send('hello'))

      expect(core.streamChat).toHaveBeenCalledWith(
        expect.objectContaining({ semanticSearchEnabled: false }),
      )
    } finally {
      setPlatformSurface({ mobileApp: false })
    }
  })

  it('holds the composer draft and clears it when a send goes through', async () => {
    scriptTurn([{ type: 'complete', messages: [{ role: 'assistant', content: 'Hi.' }] }])
    renderProvider()
    await waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

    act(() => session?.setDraft('half-typed question'))
    expect(session?.draft).toBe('half-typed question')

    await act(() => session?.send('half-typed question'))
    expect(session?.draft).toBe('')
    expect(session?.turns.at(-1)?.userText).toBe('half-typed question')
  })

  it('opens a past conversation and switches the active id', async () => {
    renderProvider()
    await waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

    await act(() => session?.openConversation('conv-9'))

    expect(core.loadChatMessages).toHaveBeenCalledWith('conv-9')
    expect(session?.activeConversationId).toBe('conv-9')
    expect(session?.turns).toEqual([RESTORED_TURN])
  })

  it('abandons a switch when a send settled while the rows loaded', async () => {
    // The send both starts AND finishes during the load — the in-flight slot
    // is already clear when the rows arrive, but the switch must still be
    // abandoned: swapping the transcript would hide the turn the user just
    // streamed into the on-screen conversation.
    let releaseLoad: (turns: ChatTurn[]) => void = () => {}
    core.loadChatMessages.mockImplementation(
      () =>
        new Promise<ChatTurn[]>((resolve) => {
          releaseLoad = resolve
        }),
    )
    scriptTurn([{ type: 'complete', messages: [{ role: 'assistant', content: 'Hi.' }] }])
    renderProvider()
    await waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())
    const homeConversation = session?.activeConversationId

    let openDone: Promise<void> | undefined
    await act(async () => {
      openDone = session?.openConversation('conv-9')
      await Promise.resolve()
    })
    await act(() => session?.send('hello'))
    expect(session?.turns.at(-1)?.status).toBe('done')

    releaseLoad([RESTORED_TURN])
    await act(async () => {
      await openDone
    })

    expect(session?.activeConversationId).toBe(homeConversation)
    expect(session?.turns.map((turn) => turn.userText)).toEqual(['hello'])
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
    const sentInto = core.saveChatMessage.mock.calls[0]![0] as { conversation: { id: string } }

    // Delete the conversation while the turn is streaming, then let it settle:
    // the settle-time save must not resurrect the deleted row.
    await act(() => session?.deleteConversation(sentInto.conversation.id))
    releaseStream()
    await act(async () => {
      await sendDone
    })

    expect(core.saveChatMessage).toHaveBeenCalledTimes(1)
  })

  it('lets an in-flight save land before deleting its conversation', async () => {
    // The delete and a dispatched save are independent IPC commands with no
    // ordering guarantee — the provider must hold the delete until the
    // conversation's save chain settles, or the upsert could resurrect it.
    let releaseSave: () => void = () => {}
    core.saveChatMessage.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve
        }),
    )
    scriptTurn([{ type: 'complete', messages: [{ role: 'assistant', content: 'Hi.' }] }])
    renderProvider()
    await waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

    await act(() => session?.send('hello'))
    const sentInto = core.saveChatMessage.mock.calls[0]![0] as { conversation: { id: string } }

    let deleteDone: Promise<void> | undefined
    await act(async () => {
      deleteDone = session?.deleteConversation(sentInto.conversation.id)
      await Promise.resolve()
    })
    expect(core.deleteChatConversation).not.toHaveBeenCalled()

    releaseSave()
    await act(async () => {
      await deleteDone
    })
    expect(core.deleteChatConversation).toHaveBeenCalledWith(sentInto.conversation.id, 7)
  })
})

describe('ChatProvider model selection', () => {
  it('starts on the persisted model selection', async () => {
    settingsState.selection = { configId: 'm1', modelId: 'gpt-5.5' }
    renderProvider()
    await waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

    expect(session?.activeModel).toEqual({ ...MODEL, model: 'gpt-5.5' })
  })

  it('persists a picked model and applies it to the session', async () => {
    renderProvider()
    await waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())
    expect(session?.activeModel).toEqual(MODEL)

    act(() => session?.selectModel({ configId: 'm1', modelId: 'gpt-5.5' }))

    expect(updateSettings).toHaveBeenCalledWith({
      chatModelSelection: { configId: 'm1', modelId: 'gpt-5.5' },
    })
    expect(session?.activeModel).toEqual({ ...MODEL, model: 'gpt-5.5' })
  })

  it('falls back to the default model when the persisted selection dangles', async () => {
    settingsState.selection = { configId: 'gone', modelId: 'gpt-5.5' }
    renderProvider()
    await waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

    expect(session?.activeModel).toEqual(MODEL)
  })
})
