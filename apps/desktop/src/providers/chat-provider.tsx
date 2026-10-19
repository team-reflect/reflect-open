import { useMemo } from 'react'
import type { ChatSession, ChatSessionState } from '@reflect/core'
import { useMaybeGraphServices } from '@/services/services-provider.tsx'
import { useServiceState } from '@/services/use-service-state.ts'

/**
 * The chat session of the open graph (Plan 10): the conversation lives in the
 * graph's `ChatSession`, not in the screen, so navigating away and back keeps
 * it. The session (`@reflect/core`) owns the turns, the composer draft and
 * attachments, sending, and persistence.
 */

export type { ChatStatus } from '@reflect/core'

export type ChatContextValue = ChatSessionState &
  Omit<ChatSession, 'getState' | 'subscribe' | 'attach'>

const NO_CHAT = {
  subscribe: () => () => {},
  getState: (): ChatSessionState | null => null,
}

/**
 * The chat session of the open graph.
 */
export function useChatSession(): ChatContextValue {
  const value = useMaybeChatSession()
  if (value === null) {
    throw new Error('useChatSession must be used while a graph is open')
  }
  return value
}

/**
 * The chat session of the open graph, or `null` while no graph is open.
 */
export function useMaybeChatSession(): ChatContextValue | null {
  const session = useMaybeGraphServices()?.chat ?? null
  const store = session ?? NO_CHAT
  const state = useServiceState<ChatSessionState | null>(store, store.getState)
  const value = useMemo((): ChatContextValue | null => {
    return session === null || state === null
      ? null
      : {
          ...state,
          selectModel: (selection) => session.selectModel(selection),
          setDraft: (text) => session.setDraft(text),
          attachImages: (files) => session.attachImages(files),
          removeAttachment: (id) => session.removeAttachment(id),
          send: (text) => session.send(text),
          stop: () => session.stop(),
          newChat: () => session.newChat(),
          openConversation: (id) => session.openConversation(id),
          deleteConversation: (id) => session.deleteConversation(id),
        }
  }, [state, session])
  return value
}
