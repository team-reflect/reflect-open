import { renderHook } from 'vitest-browser-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type {
  AiProviderConfig,
  ChatConversation,
  ChatModelSelection,
  ChatNoteChange,
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
  aiApiKeyForConfig: vi.fn<(config: AiProviderConfig) => Promise<string | null>>(),
  getSecret: vi.fn<(name: string) => Promise<string | null>>(),
  hasBridge: vi.fn<() => boolean>(),
  loadChatGraphContext: vi.fn<(graphName: string) => Promise<null>>(),
  listChatConversations: vi.fn<(limit?: number) => Promise<ChatConversation[]>>(),
  loadChatMessages: vi.fn<(id: string) => Promise<ChatTurn[]>>(),
  chatNoteChangesForTurn:
    vi.fn<(turnId: string, generation: number) => Promise<ChatNoteChange[]>>(),
  saveChatMessage: vi.fn<(input: unknown) => Promise<void>>(),
  deleteChatConversation: vi.fn<(id: string, generation: number) => Promise<void>>(),
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  ...core,
}))

const noteChanges = vi.hoisted(() => {
  const readNote = vi.fn(async () => '# Note\n')
  const applyChange = vi.fn(async () => ({
    ok: false as const,
    code: 'failed' as const,
    message: 'No note mutation was scripted for this test.',
  }))
  const createNote = vi.fn(async () => ({
    ok: false as const,
    code: 'failed' as const,
    message: 'No note creation was scripted for this test.',
  }))
  const seal = vi.fn()
  const settled = vi.fn(async () => {})
  const reconcilePendingChanges = vi.fn(async () => [])
  const undoTurn = vi.fn(async () => ({ ok: true, undonePaths: [], failures: [] }))
  const undoPath = vi.fn(async () => ({ ok: true, undonePaths: [], failures: [] }))
  return {
    readNote,
    applyChange,
    createNote,
    seal,
    settled,
    reconcilePendingChanges,
    undoTurn,
    undoPath,
    createHost: vi.fn(() => ({ readNote, applyChange, createNote, seal, settled })),
    createService: vi.fn(() => ({ reconcilePendingChanges, undoTurn, undoPath })),
  }
})
vi.mock('@/lib/ai-note-tool-host', () => ({
  createDesktopChatNoteToolHost: noteChanges.createHost,
  createDesktopChatNoteChangeService: noteChanges.createService,
}))

const settingsState = vi.hoisted(() => ({
  models: [] as AiProviderConfig[],
  defaultId: null as string | null,
  selection: null as ChatModelSelection | null,
  semanticSearchEnabled: false,
  chatSystemPrompt: '',
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
          chatSystemPrompt: settingsState.chatSystemPrompt,
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
  permissionMode: 'read',
  sourceProvenance: [],
  status: 'done',
}

function conversation(overrides: Partial<ChatConversation> = {}): ChatConversation {
  return {
    id: 'conv-1',
    title: 'what did I write yesterday?',
    createdMs: 1,
    updatedMs: Date.now(),
    ...overrides,
  }
}

let session: ReturnType<typeof useChatSession> | null = null

const GRAPH: GraphInfo = { root: '/g', name: 'test-graph', generation: 1 }

function renderProvider() {
  session = null
  return renderHook(
    () => {
      session = useChatSession()
      return session
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ChatProvider graph={GRAPH}>{children}</ChatProvider>
      ),
    },
  )
}

function scriptTurn(events: ChatStreamEvent[]) {
  core.streamChat.mockImplementation(function script() {
    return (async function* () {
      yield* events
    })()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  settingsState.models = [MODEL]
  settingsState.defaultId = 'm1'
  settingsState.selection = null
  settingsState.semanticSearchEnabled = false
  settingsState.chatSystemPrompt = ''
  core.hasBridge.mockReturnValue(true)
  core.aiApiKeyForConfig.mockResolvedValue('sk-test')
  core.getSecret.mockResolvedValue('sk-test')
  core.loadChatGraphContext.mockResolvedValue(null)
  core.listChatConversations.mockResolvedValue([])
  core.loadChatMessages.mockResolvedValue([RESTORED_TURN])
  core.chatNoteChangesForTurn.mockResolvedValue([])
  core.saveChatMessage.mockResolvedValue(undefined)
  core.deleteChatConversation.mockResolvedValue(undefined)
  noteChanges.readNote.mockResolvedValue('# Public note\n')
})

describe('ChatProvider persistence', () => {
  it('resumes the latest conversation when it is fresh enough', async () => {
    core.listChatConversations.mockResolvedValue([conversation()])
    await renderProvider()

    await vi.waitFor(() => expect(session?.turns).toEqual([RESTORED_TURN]))
    expect(session?.activeConversationId).toBe('conv-1')
    expect(core.loadChatMessages).toHaveBeenCalledWith('conv-1')
  })

  it('starts fresh when the latest conversation idled past the cutoff', async () => {
    core.listChatConversations.mockResolvedValue([
      conversation({ updatedMs: Date.now() - 7 * 60 * 60 * 1000 }),
    ])
    await renderProvider()

    await vi.waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())
    expect(core.loadChatMessages).not.toHaveBeenCalled()
    expect(session?.turns).toEqual([])
    expect(session?.activeConversationId).not.toBe('conv-1')
  })

  it('saves the user half at send and the settled turn after the stream', async () => {
    scriptTurn([
      { type: 'text-delta', text: 'Hi.' },
      { type: 'complete', messages: [{ role: 'assistant', content: 'Hi.' }] },
    ])
    const { act } = await renderProvider()
    await vi.waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

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
        result: {
          tool: 'read',
          toolCallId: 't1',
          notes: [{ path: 'notes/a.md', title: 'A', error: null }],
        },
      },
      { type: 'complete', messages: [{ role: 'assistant', content: 'noop' }] },
    ])
    const { act } = await renderProvider()
    await vi.waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

    await act(() => session?.send('summarize my notes'))

    const notice = { kind: 'notice', tone: 'info', text: NO_REPLY_NOTICE }
    expect(session?.turns.at(-1)?.parts.at(-1)).toEqual(notice)
    const saved = core.saveChatMessage.mock.calls.at(-1)![0] as { turn: ChatTurn }
    expect(saved.turn.parts.at(-1)).toEqual(notice)
  })

  it('saves later turns into the restored conversation', async () => {
    core.listChatConversations.mockResolvedValue([conversation()])
    scriptTurn([{ type: 'complete', messages: [{ role: 'assistant', content: 'More.' }] }])
    const { act } = await renderProvider()
    await vi.waitFor(() => expect(session?.turns).toHaveLength(1))

    await act(() => session?.send('and today?'))

    expect(core.saveChatMessage.mock.calls[0]![0]).toMatchObject({
      conversation: { id: 'conv-1', title: 'what did I write yesterday?' },
      turn: { userText: 'and today?' },
    })
  })

  it('passes the semantic search setting into chat turns', async () => {
    settingsState.semanticSearchEnabled = true
    scriptTurn([{ type: 'complete', messages: [{ role: 'assistant', content: 'Hi.' }] }])
    const { act } = await renderProvider()
    await vi.waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

    await act(() => session?.send('hello'))

    expect(core.streamChat).toHaveBeenCalledWith(
      expect.objectContaining({ semanticSearchEnabled: true }),
    )
  })

  it('passes the latest configured system prompt into the next chat turn', async () => {
    const { act, rerender } = await renderProvider()
    await vi.waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())
    settingsState.chatSystemPrompt = 'Answer like a rigorous research partner.'
    await rerender()
    scriptTurn([{ type: 'complete', messages: [{ role: 'assistant', content: 'Hi.' }] }])

    await act(() => session?.send('hello'))

    expect(core.streamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        customSystemPrompt: 'Answer like a rigorous research partner.',
      }),
    )
  })

  it('forces lexical search on the mobile surface, over an enabled setting', async () => {
    settingsState.semanticSearchEnabled = true
    setPlatformSurface({ mobileApp: true })
    try {
      scriptTurn([{ type: 'complete', messages: [{ role: 'assistant', content: 'Hi.' }] }])
      const { act } = await renderProvider()
      await vi.waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

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
    const { act } = await renderProvider()
    await vi.waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

    await act(() => session?.setDraft('half-typed question'))
    expect(session?.draft).toBe('half-typed question')

    await act(() => session?.send('half-typed question'))
    expect(session?.draft).toBe('')
    expect(session?.turns.at(-1)?.userText).toBe('half-typed question')
  })

  it('opens a past conversation and switches the active id', async () => {
    const { act } = await renderProvider()
    await vi.waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

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
    const { act } = await renderProvider()
    await vi.waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())
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
    const { act } = await renderProvider()
    await vi.waitFor(() => expect(session?.activeConversationId).toBe('conv-1'))

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
    const { act } = await renderProvider()
    await vi.waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

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

  it('aborts and seals a conversation before deleting it mid-stream', async () => {
    let releaseStream: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    core.streamChat.mockImplementation(function script() {
      return (async function* () {
        yield { type: 'text-delta', text: 'Working…' } satisfies ChatStreamEvent
        await gate
        yield { type: 'aborted', messages: [] } satisfies ChatStreamEvent
      })()
    })
    const { act } = await renderProvider()
    await vi.waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

    let sendDone: Promise<void> | undefined
    await act(async () => {
      sendDone = session?.send('change my note')
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(core.streamChat).toHaveBeenCalled())
    const sentInto = core.saveChatMessage.mock.calls[0]![0] as { conversation: { id: string } }
    const signal = core.streamChat.mock.calls[0]![0].signal
    core.deleteChatConversation.mockImplementation(async () => {
      expect(signal?.aborted).toBe(true)
    })

    await act(() => session?.deleteConversation(sentInto.conversation.id))

    expect(signal?.aborted).toBe(true)
    expect(noteChanges.seal).toHaveBeenCalledOnce()
    expect(noteChanges.seal.mock.invocationCallOrder[0]).toBeLessThan(
      noteChanges.settled.mock.invocationCallOrder[0]!,
    )
    expect(noteChanges.settled.mock.invocationCallOrder[0]).toBeLessThan(
      core.deleteChatConversation.mock.invocationCallOrder[0]!,
    )

    releaseStream()
    await act(async () => {
      await sendDone
    })
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
    const { act } = await renderProvider()
    await vi.waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

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

describe('ChatProvider note permissions', () => {
  it('defaults to read and never restores a historic write grant', async () => {
    const historicWriteTurn = { ...RESTORED_TURN, permissionMode: 'readWrite' as const }
    core.listChatConversations.mockResolvedValue([conversation()])
    core.loadChatMessages.mockResolvedValue([historicWriteTurn])

    await renderProvider()

    await vi.waitFor(() => expect(session?.turns).toEqual([historicWriteTurn]))
    expect(session?.permissionMode).toBe('read')
    expect(session?.turns[0]?.permissionMode).toBe('readWrite')
  })

  it('resets write permission for new and opened conversations', async () => {
    const { act } = await renderProvider()
    await vi.waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

    await act(() => session?.setPermissionMode('readWrite'))
    expect(session?.permissionMode).toBe('readWrite')
    await act(() => session?.newChat())
    expect(session?.permissionMode).toBe('read')

    await act(() => session?.setPermissionMode('readWrite'))
    await act(() => session?.openConversation('conv-9'))
    expect(session?.permissionMode).toBe('read')
  })

  it('captures write permission at send and durably persists it on the turn', async () => {
    let releaseStream: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    core.streamChat.mockImplementation(function script() {
      return (async function* () {
        yield { type: 'text-delta', text: 'Updated.' } satisfies ChatStreamEvent
        await gate
        yield {
          type: 'complete',
          messages: [{ role: 'assistant', content: 'Updated.' }],
        } satisfies ChatStreamEvent
      })()
    })
    const { act } = await renderProvider()
    await vi.waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())
    await act(() => session?.setPermissionMode('readWrite'))

    let sendDone: Promise<void> | undefined
    await act(async () => {
      sendDone = session?.send('append an update')
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(core.streamChat).toHaveBeenCalled())

    // The composer disables this control while streaming. Calling the context
    // setter directly still proves the in-flight turn uses its send-time grant.
    await act(() => session?.setPermissionMode('read'))
    releaseStream()
    await act(async () => {
      await sendDone
    })

    expect(core.streamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionMode: 'readWrite',
        noteHost: noteChanges.createHost.mock.results[0]?.value,
      }),
    )
    expect(core.saveChatMessage.mock.invocationCallOrder[0]).toBeLessThan(
      core.streamChat.mock.invocationCallOrder[0]!,
    )
    const savedTurns = core.saveChatMessage.mock.calls.map(
      ([input]) => (input as { turn: ChatTurn }).turn,
    )
    expect(savedTurns).not.toHaveLength(0)
    expect(savedTurns.every((turn) => turn.permissionMode === 'readWrite')).toBe(true)
    expect(session?.turns.at(-1)?.permissionMode).toBe('readWrite')
    expect(session?.permissionMode).toBe('read')
  })

  it('does not escalate a read turn when the next-turn mode changes mid-stream', async () => {
    let releaseStream: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    core.streamChat.mockImplementation(function script() {
      return (async function* () {
        yield { type: 'text-delta', text: 'Reading.' } satisfies ChatStreamEvent
        await gate
        yield {
          type: 'complete',
          messages: [{ role: 'assistant', content: 'Reading.' }],
        } satisfies ChatStreamEvent
      })()
    })
    const { act } = await renderProvider()
    await vi.waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

    let sendDone: Promise<void> | undefined
    await act(async () => {
      sendDone = session?.send('read my notes')
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(core.streamChat).toHaveBeenCalled())
    await act(() => session?.setPermissionMode('readWrite'))
    releaseStream()
    await act(async () => {
      await sendDone
    })

    expect(core.streamChat).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: 'read' }),
    )
    const savedTurns = core.saveChatMessage.mock.calls.map(
      ([input]) => (input as { turn: ChatTurn }).turn,
    )
    expect(savedTurns).not.toHaveLength(0)
    expect(savedTurns.every((turn) => turn.permissionMode === 'read')).toBe(true)
    expect(session?.turns.at(-1)?.permissionMode).toBe('read')
    expect(session?.permissionMode).toBe('readWrite')
  })

  it('honors an immediate write-permission revocation before Send', async () => {
    scriptTurn([{ type: 'complete', messages: [{ role: 'assistant', content: 'Read.' }] }])
    const { act } = await renderProvider()
    await vi.waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

    await act(async () => {
      session?.setPermissionMode('readWrite')
      session?.setPermissionMode('read')
      await session?.send('read this without editing')
    })

    expect(core.streamChat).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: 'read' }),
    )
    expect(session?.turns.at(-1)?.permissionMode).toBe('read')
  })
})

describe('ChatProvider step privacy', () => {
  const source = { kind: 'note' as const, path: 'notes/grounded.md' }
  const groundedTurn: ChatTurn = {
    ...RESTORED_TURN,
    sourceProvenance: [source],
  }

  it('rebuilds prior history through the live host while retaining the current user', async () => {
    core.listChatConversations.mockResolvedValue([conversation()])
    core.loadChatMessages.mockResolvedValue([groundedTurn])
    scriptTurn([{ type: 'complete', messages: [{ role: 'assistant', content: 'Current.' }] }])
    const { act } = await renderProvider()
    await vi.waitFor(() => expect(session?.turns).toEqual([groundedTurn]))

    await act(() => session?.send('and today?'))
    const options = core.streamChat.mock.calls.at(-1)?.[0]
    if (options === undefined) {
      expect.unreachable('expected stream options')
    }
    expect(JSON.stringify(options.messages)).toContain(RESTORED_TURN.userText)

    noteChanges.readNote.mockResolvedValue('---\nprivate: true\n---\n# Grounded\n')
    await expect(options.revalidateHistory()).resolves.toEqual([
      { role: 'user', content: 'and today?' },
    ])
    await expect(options.validateSource(source)).resolves.toBe(false)
  })

  it('never adds history that was excluded when the turn started', async () => {
    core.listChatConversations.mockResolvedValue([conversation()])
    core.loadChatMessages.mockResolvedValue([groundedTurn])
    noteChanges.readNote.mockResolvedValue('---\nprivate: true\n---\n# Grounded\n')
    scriptTurn([{ type: 'complete', messages: [{ role: 'assistant', content: 'Current.' }] }])
    const { act } = await renderProvider()
    await vi.waitFor(() => expect(session?.turns).toEqual([groundedTurn]))

    await act(() => session?.send('current question'))
    const options = core.streamChat.mock.calls.at(-1)?.[0]
    if (options === undefined) {
      expect.unreachable('expected stream options')
    }
    expect(options.messages).toEqual([{ role: 'user', content: 'current question' }])

    noteChanges.readNote.mockResolvedValue('# Public again\n')
    await expect(options.revalidateHistory()).resolves.toEqual([
      { role: 'user', content: 'current question' },
    ])
  })
})

describe('ChatProvider model selection', () => {
  it('starts on the persisted model selection', async () => {
    settingsState.selection = { configId: 'm1', modelId: 'gpt-5.5' }
    await renderProvider()
    await vi.waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

    expect(session?.activeModel).toEqual({ ...MODEL, model: 'gpt-5.5' })
  })

  it('persists a picked model and applies it to the session', async () => {
    const { act } = await renderProvider()
    await vi.waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())
    expect(session?.activeModel).toEqual(MODEL)

    await act(() => session?.selectModel({ configId: 'm1', modelId: 'gpt-5.5' }))

    expect(updateSettings).toHaveBeenCalledWith({
      chatModelSelection: { configId: 'm1', modelId: 'gpt-5.5' },
    })
    expect(session?.activeModel).toEqual({ ...MODEL, model: 'gpt-5.5' })
  })

  it('falls back to the default model when the persisted selection dangles', async () => {
    settingsState.selection = { configId: 'gone', modelId: 'gpt-5.5' }
    await renderProvider()
    await vi.waitFor(() => expect(core.listChatConversations).toHaveBeenCalled())

    expect(session?.activeModel).toEqual(MODEL)
  })
})
