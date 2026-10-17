import { describe, expect, it, vi } from 'vitest'
import { createRef, useLayoutEffect, type ReactElement, type RefObject } from 'react'
import { aiKeySecretName, type AiProviderConfig, type ChatTurn, type Settings } from '@reflect/core'
import {
  createTestCoreServices,
  createTestChatEngineService,
  createTestChatHistoryService,
  createTestSecretStoreService,
  createTestSettingsService,
  type TestChatConversation,
  type TestOpenGraph,
} from '@reflect/core/testing'
import { useChatSession, type ChatContextValue } from '@/providers/chat-provider.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'

/**
 * The hook as a shell over the open graph's chat session: it publishes the
 * session state and controls. The session's own lifecycle is covered by
 * `chat-session-service.test.ts`, and its creation by
 * `create-graph-services.test.ts`.
 */

const MODEL: AiProviderConfig = { id: 'm1', provider: 'openai', model: 'gpt-5.4', keyHint: '12345' }

const GRAPH: TestOpenGraph = { root: '/g', name: 'test-graph', generation: 1, indexGeneration: 7 }

const RESTORED_TURN: ChatTurn = {
  id: 'turn-old',
  userText: 'what did I write yesterday?',
  attachments: [],
  parts: [{ kind: 'text', text: 'Three notes.' }],
  responseMessages: [{ role: 'assistant', content: 'Three notes.' }],
  status: 'done',
}

const sessionRef: RefObject<ChatContextValue | null> = createRef()

function SessionProbe(): ReactElement | null {
  const session = useChatSession()

  useLayoutEffect(() => {
    sessionRef.current = session
    return () => {
      sessionRef.current = null
    }
  }, [session])

  return null
}

async function renderProvider(options?: {
  conversations?: readonly TestChatConversation[]
  settings?: Partial<Settings>
}) {
  sessionRef.current = null
  const settings = createTestSettingsService({
    aiProviders: [MODEL],
    defaultAiProviderId: 'm1',
    ...options?.settings,
  })
  await settings.whenLoaded()
  const chatHistory = createTestChatHistoryService(
    options?.conversations === undefined ? {} : { conversations: options.conversations },
  )
  const chatEngine = createTestChatEngineService([
    { type: 'text-delta', text: 'Hi.' },
    { type: 'complete', messages: [{ role: 'assistant', content: 'Hi.' }] },
  ])
  const app = createTestCoreServices({
    settings,
    secretStore: createTestSecretStoreService({ [aiKeySecretName(MODEL.id)]: 'sk-test' }),
    chatHistory,
    chatEngine,
  })
  const view = await renderInApp(<SessionProbe />, { app, graph: GRAPH, route: null })
  return { view, app, chatHistory, chatEngine }
}

describe('useChatSession', () => {
  it('resumes the latest conversation of the graph on mount', async () => {
    await renderProvider({
      conversations: [
        {
          conversation: {
            id: 'conv-1',
            title: 'what did I write yesterday?',
            createdMs: 1,
            updatedMs: 0,
          },
          turns: [RESTORED_TURN],
        },
      ],
    })

    await vi.waitFor(() => expect(sessionRef.current?.turns).toEqual([RESTORED_TURN]))
    expect(sessionRef.current?.activeConversationId).toBe('conv-1')
  })

  it('publishes a sent turn and saves it under the index generation', async () => {
    const { chatHistory, chatEngine } = await renderProvider()

    await sessionRef.current?.send('hello there')

    await vi.waitFor(() => expect(sessionRef.current?.turns.at(-1)?.status).toBe('done'))
    expect(sessionRef.current?.turns.at(-1)).toMatchObject({
      userText: 'hello there',
      parts: [{ kind: 'text', text: 'Hi.' }],
    })
    expect(sessionRef.current?.status).toBe('idle')
    expect(chatEngine.calls()).toHaveLength(1)
    await vi.waitFor(() => expect(chatHistory.getSaves()).toHaveLength(2))
    expect(chatHistory.getSaves()[0]).toMatchObject({
      generation: 7,
      conversation: { id: sessionRef.current?.activeConversationId, title: 'hello there' },
    })
  })

  it('holds the composer draft and clears it when a send goes through', async () => {
    await renderProvider()

    sessionRef.current?.setDraft('half-typed question')
    await vi.waitFor(() => expect(sessionRef.current?.draft).toBe('half-typed question'))

    await sessionRef.current?.send('half-typed question')
    await vi.waitFor(() => expect(sessionRef.current?.draft).toBe(''))
    expect(sessionRef.current?.turns.at(-1)?.userText).toBe('half-typed question')
  })

  it('persists a picked model and applies it to the session', async () => {
    const { app } = await renderProvider()
    expect(sessionRef.current?.activeModel).toEqual(MODEL)

    sessionRef.current?.selectModel({ configId: 'm1', modelId: 'gpt-5.5' })

    await vi.waitFor(() =>
      expect(sessionRef.current?.activeModel).toEqual({ ...MODEL, model: 'gpt-5.5' }),
    )
    expect(app.settings.get().chatModelSelection).toEqual({ configId: 'm1', modelId: 'gpt-5.5' })
  })

  it('aborts the in-flight turn when the graph session ends', async () => {
    const { app, chatEngine } = await renderProvider()
    let signal: AbortSignal | undefined
    chatEngine.setScript(async function* (request) {
      signal = request.signal
      yield { type: 'text-delta', text: 'Hi' }
      // Never settles — the turn only ends through the abort signal.
      await new Promise<never>(() => {})
    })

    void sessionRef.current?.send('hey')
    await vi.waitFor(() => expect(signal).toBeDefined())
    expect(signal?.aborted).toBe(false)

    app.graphSession.setGraph({ root: '/other' })
    expect(signal?.aborted).toBe(true)
  })
})
