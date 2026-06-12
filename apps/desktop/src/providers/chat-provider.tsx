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
  type ChatModelMessage,
  type ChatStreamEvent,
} from '@reflect/core'
import { appendEvent, type ChatTranscriptMessage } from '@/lib/chat-transcript'
import { todayIso } from '@/lib/dates'
import { providerFetch } from '@/lib/provider-fetch'
import { useSettings } from '@/providers/settings-provider'

/**
 * One chat session per open graph (Plan 10): the conversation lives here, not
 * in the screen, so navigating away and back keeps it. Session-only by
 * design — a relaunch (or graph switch, which remounts the workspace tree)
 * starts fresh. The model-facing history is kept separately from the rendered
 * transcript: the transcript carries tool activity for display, the history
 * carries the exact messages (including tool results) the next turn resends.
 */

export type ChatStatus = 'idle' | 'streaming'

interface ChatContextValue {
  transcript: ChatTranscriptMessage[]
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
  const [transcript, setTranscript] = useState<ChatTranscriptMessage[]>([])
  const [status, setStatus] = useState<ChatStatus>('idle')
  const [modelId, setModelId] = useState<string | null>(null)

  const models = settings.aiModels
  const activeModel =
    (modelId !== null ? (models.find((model) => model.id === modelId) ?? null) : null) ??
    defaultAiModel({ models, defaultModelId: settings.defaultAiModelId })

  // Mutated, never rendered: the exact model-facing message list.
  const historyRef = useRef<ChatModelMessage[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const statusRef = useRef<ChatStatus>('idle')
  statusRef.current = status
  const activeModelRef = useRef<AiModelConfig | null>(activeModel)
  activeModelRef.current = activeModel

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

    const assistantId = crypto.randomUUID()
    const applyEvent = (event: ChatStreamEvent) => {
      setTranscript((current) =>
        current.map((message) =>
          message.id === assistantId && message.role === 'assistant'
            ? { ...message, parts: appendEvent(message.parts, event) }
            : message,
        ),
      )
    }

    setTranscript((current) => [
      ...current,
      { id: crypto.randomUUID(), role: 'user', text: trimmed },
      { id: assistantId, role: 'assistant', parts: [] },
    ])
    historyRef.current.push({ role: 'user', content: trimmed })
    setStatus('streaming')
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
        messages: [...historyRef.current],
        today: todayIso(),
        signal: controller.signal,
      })
      for await (const event of events) {
        // Every terminal event carries the turn's messages — for a stopped or
        // failed turn that's the completed steps plus partial text, so the
        // history the next turn resends matches what stayed on screen.
        if (event.type === 'complete' || event.type === 'aborted' || event.type === 'error') {
          historyRef.current.push(...event.messages)
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
      abortRef.current = null
      setStatus('idle')
    }
  }, [])

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const newChat = useCallback(() => {
    abortRef.current?.abort()
    historyRef.current = []
    setTranscript([])
  }, [])

  const selectModel = useCallback((id: string | null) => {
    setModelId(id)
  }, [])

  const value = useMemo<ChatContextValue>(
    () => ({ transcript, status, models, activeModel, selectModel, send, stop, newChat }),
    [transcript, status, models, activeModel, selectModel, send, stop, newChat],
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
