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
  chatModelOptions,
  errorMessage,
  getSecret,
  resolveChatModel,
  streamChat,
  type AiProviderConfig,
  type ChatModelOption,
  type ChatModelSelection,
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
  /** Configured provider entries (empty → the add-a-provider CTA). */
  providers: AiProviderConfig[]
  /** Every model the picker offers: each provider's full curated list. */
  modelOptions: ChatModelOption[]
  /**
   * The provider entry + model the next turn calls (`model` already carries
   * the session's choice) — session override or the settings default.
   */
  activeModel: AiProviderConfig | null
  /** Override the session's model (null returns to the settings default). */
  selectModel: (selection: ChatModelSelection | null) => void
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
  const [selection, setSelection] = useState<ChatModelSelection | null>(null)

  const status: ChatStatus = turns.at(-1)?.status === 'streaming' ? 'streaming' : 'idle'

  const providers = settings.aiProviders
  const modelOptions = useMemo(() => chatModelOptions(providers), [providers])
  const activeModel = resolveChatModel(
    { providers, defaultProviderId: settings.defaultAiProviderId },
    selection,
  )

  // Read at call time, not captured: send() can fire long after the render
  // that created it.
  const turnsRef = useRef(turns)
  turnsRef.current = turns
  const activeModelRef = useRef<AiProviderConfig | null>(activeModel)
  activeModelRef.current = activeModel

  // The in-flight send, tracked synchronously — the no-concurrent-sends
  // guard can't ride on rendered state, which only reflects a send after
  // the next render. `session` ties a send to its conversation: New chat
  // bumps the counter, so a detached send winding down no longer counts as
  // "this conversation is busy" and never clears a successor's slot.
  const sessionRef = useRef(0)
  const activeSendRef = useRef<{ controller: AbortController; session: number } | null>(null)

  // The workspace tree is keyed by graph root, so switching graphs unmounts
  // this provider — an in-flight turn must die with it, or its tools would
  // keep reading whichever graph Rust has open *now* and ship that content
  // to the provider under the old conversation.
  useEffect(() => {
    return () => {
      activeSendRef.current?.controller.abort()
    }
  }, [])

  const send = useCallback(async (text: string): Promise<void> => {
    const trimmed = text.trim()
    const config = activeModelRef.current
    if (
      trimmed === '' ||
      config === null ||
      activeSendRef.current?.session === sessionRef.current
    ) {
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
    const activeSend = { controller, session: sessionRef.current }
    activeSendRef.current = activeSend

    try {
      const apiKey = await getSecret(aiKeySecretName(config.id))
      if (apiKey === null) {
        applyEvent({
          type: 'error',
          message: 'No API key found for this provider — re-add it in Settings → AI providers.',
          messages: [],
        })
        return
      }
      const events = streamChat({
        config,
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
      // Only release the slot if it's still ours: a turn detached by New
      // chat must not, while winding down, unhook the controller a newer
      // turn has since registered — Stop and the unmount abort always have
      // to target the live stream.
      if (activeSendRef.current === activeSend) {
        activeSendRef.current = null
      }
    }
  }, [])

  const stop = useCallback(() => {
    activeSendRef.current?.controller.abort()
  }, [])

  const newChat = useCallback(() => {
    activeSendRef.current?.controller.abort()
    sessionRef.current += 1
    setTurns([])
  }, [])

  const selectModel = useCallback((next: ChatModelSelection | null) => {
    setSelection(next)
  }, [])

  const value = useMemo<ChatContextValue>(
    () => ({ turns, status, providers, modelOptions, activeModel, selectModel, send, stop, newChat }),
    [turns, status, providers, modelOptions, activeModel, selectModel, send, stop, newChat],
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
