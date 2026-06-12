import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  aiKeySecretName,
  defaultAiModel,
  errorMessage,
  getSecret,
  streamChat,
  type AiModelConfig,
  type ChatStreamEvent,
} from '@reflect/core'
import { appendEvent, buildHistory, type ChatTurn } from '@/lib/chat-transcript'
import { todayIso } from '@/lib/dates'
import { providerFetch } from '@/lib/provider-fetch'
import { useSettings } from '@/providers/settings-provider'

/**
 * One chat session per open graph (Plan 10): the conversation lives here, not
 * in the screen, so navigating away and back keeps it. Session-only by
 * design — a relaunch (or graph switch, which remounts the workspace tree)
 * starts fresh. The state is just {@link ChatTurn}s: what each turn renders
 * and what it contributed to the model history are one record, and the
 * history a new turn resends is derived from them.
 */

export type ChatStatus = 'idle' | 'streaming'

interface ChatContextValue {
  turns: ChatTurn[]
  status: ChatStatus
  /** Configured BYOK entries (the picker's options). */
  models: AiModelConfig[]
  /** The entry the next turn calls — session override or settings default. */
  activeModel: AiModelConfig | null
  /** Override the session's model (null returns to the settings default). */
  selectModel: (id: string | null) => void
  /** Send one user message and stream the assistant's turn. */
  send: (text: string) => Promise<void>
  /** Abort the in-flight turn (partial text stays in the transcript). */
  stop: () => void
  /** Drop the conversation and start over. */
  newChat: () => void
}

const ChatContext = createContext<ChatContextValue | null>(null)

export function ChatProvider({ children }: { children: ReactNode }): ReactElement {
  const { settings } = useSettings()
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [modelId, setModelId] = useState<string | null>(null)

  const status: ChatStatus = turns.at(-1)?.status === 'streaming' ? 'streaming' : 'idle'

  const models = settings.aiModels
  const activeModel =
    (modelId !== null ? (models.find((model) => model.id === modelId) ?? null) : null) ??
    defaultAiModel({ models, defaultModelId: settings.defaultAiModelId })

  // Read at call time, not captured: send() can fire long after the render
  // that created it.
  const turnsRef = useRef(turns)
  turnsRef.current = turns
  const statusRef = useRef(status)
  statusRef.current = status
  const activeModelRef = useRef<AiModelConfig | null>(activeModel)
  activeModelRef.current = activeModel
  const abortRef = useRef<AbortController | null>(null)

  // The workspace tree is keyed by graph root, so switching graphs unmounts
  // this provider — an in-flight turn must die with it, or its tools would
  // keep reading whichever graph Rust has open *now* and ship that content
  // to the provider under the old conversation.
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  const send = useCallback(async (text: string): Promise<void> => {
    const trimmed = text.trim()
    const model = activeModelRef.current
    if (trimmed === '' || statusRef.current === 'streaming' || model === null) {
      return
    }

    const turnId = crypto.randomUUID()
    const messages = [
      ...buildHistory(turnsRef.current),
      { role: 'user' as const, content: trimmed },
    ]
    const updateTurn = (updater: (turn: ChatTurn) => ChatTurn) => {
      setTurns((current) =>
        current.map((turn) => (turn.id === turnId ? updater(turn) : turn)),
      )
    }
    const applyEvent = (event: ChatStreamEvent) => {
      updateTurn((turn) => ({ ...turn, parts: appendEvent(turn.parts, event) }))
    }

    setTurns((current) => [
      ...current,
      { id: turnId, userText: trimmed, parts: [], responseMessages: [], status: 'streaming' },
    ])
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const apiKey = await getSecret(aiKeySecretName(model.id))
      if (apiKey === null) {
        applyEvent({
          type: 'error',
          message: 'No API key found for this model — re-add it in Settings → AI models.',
          messages: [],
        })
        return
      }
      const events = streamChat({
        model,
        apiKey,
        fetchFn: providerFetch,
        messages,
        today: todayIso(),
        signal: controller.signal,
      })
      for await (const event of events) {
        // Every terminal event carries the turn's messages — for a stopped or
        // failed turn that's the completed steps plus partial text, so the
        // derived history matches what stayed on screen.
        if (event.type === 'complete' || event.type === 'aborted' || event.type === 'error') {
          updateTurn((turn) => ({ ...turn, responseMessages: event.messages }))
        }
        if (event.type !== 'complete') {
          applyEvent(event)
        }
      }
    } catch (cause) {
      // streamChat normalizes its own failures; this guards the seams around
      // it (keychain read, event application) so the UI never sticks.
      applyEvent({ type: 'error', message: errorMessage(cause), messages: [] })
    } finally {
      updateTurn((turn) => ({ ...turn, status: 'done' }))
      abortRef.current = null
    }
  }, [])

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const newChat = useCallback(() => {
    abortRef.current?.abort()
    setTurns([])
  }, [])

  const selectModel = useCallback((id: string | null) => {
    setModelId(id)
  }, [])

  const value = useMemo<ChatContextValue>(
    () => ({ turns, status, models, activeModel, selectModel, send, stop, newChat }),
    [turns, status, models, activeModel, selectModel, send, stop, newChat],
  )
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

/** Access the chat session. Use within a ChatProvider. */
export function useChatSession(): ChatContextValue {
  const context = useContext(ChatContext)
  if (!context) {
    throw new Error('useChatSession must be used within a ChatProvider')
  }
  return context
}
