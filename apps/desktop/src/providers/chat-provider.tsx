import { useMemo } from 'react'
import type {
  ChatAttachment,
  ChatSession,
  ChatSessionState,
  ChatStatus,
  ChatTurn,
} from '@reflect/core'
import { useSelector } from '@/lib/use-store.ts'
import { useMaybeGraphServices } from '@/services/services-provider.tsx'

/**
 * The chat session of the open graph (Plan 10): the conversation lives in the
 * graph's `ChatSession`, not in the screen, so navigating away and back keeps
 * it. The session (`@reflect/core`) owns the turns, the composer draft and
 * attachments, sending, and persistence. Each hook below reads one field, so
 * a keystroke re-renders only the composer and a streamed delta only the
 * turn list.
 */

/**
 * The controls of the chat session, bound so surfaces can pass them around.
 */
export type ChatActions = Omit<ChatSession, 'get' | 'subscribe' | 'attach'>

/**
 * The model fields of the chat session state.
 */
export type ChatModels = Pick<ChatSessionState, 'providers' | 'modelOptions' | 'activeModel'>

function selectTurns(state: ChatSessionState): ChatTurn[] {
  return state.turns
}

function selectHasTurns(state: ChatSessionState): boolean {
  return state.turns.length > 0
}

function selectDraft(state: ChatSessionState): string {
  return state.draft
}

function selectAttachments(state: ChatSessionState): ChatAttachment[] {
  return state.attachments
}

function selectStatus(state: ChatSessionState): ChatStatus {
  return state.status
}

function selectProviders(state: ChatSessionState): ChatModels['providers'] {
  return state.providers
}

function selectModelOptions(state: ChatSessionState): ChatModels['modelOptions'] {
  return state.modelOptions
}

function selectActiveModel(state: ChatSessionState): ChatModels['activeModel'] {
  return state.activeModel
}

function selectActiveConversationId(state: ChatSessionState): string {
  return state.activeConversationId
}

function useChat(): ChatSession {
  const session = useMaybeGraphServices()?.chat
  if (session === undefined) {
    throw new Error('Chat hooks must be used while a graph is open')
  }
  return session
}

/**
 * The controls of the open graph's chat session. Reads no state, so it never
 * re-renders on a chat change.
 */
export function useChatActions(): ChatActions {
  const session = useChat()
  return useMemo(
    (): ChatActions => ({
      selectModel: (selection) => session.selectModel(selection),
      setDraft: (text) => session.setDraft(text),
      attachImages: (files) => session.attachImages(files),
      removeAttachment: (id) => session.removeAttachment(id),
      send: (text) => session.send(text),
      stop: () => session.stop(),
      newChat: () => session.newChat(),
      openConversation: (id) => session.openConversation(id),
      deleteConversation: (id) => session.deleteConversation(id),
    }),
    [session],
  )
}

/**
 * The turns of the active conversation.
 */
export function useChatTurns(): ChatTurn[] {
  return useSelector(useChat(), selectTurns)
}

/**
 * Whether the active conversation has a turn. Unlike {@link useChatTurns}, it
 * does not re-render on every streamed delta.
 */
export function useHasChatTurns(): boolean {
  return useSelector(useChat(), selectHasTurns)
}

/**
 * The composer's unsent text.
 */
export function useChatDraft(): string {
  return useSelector(useChat(), selectDraft)
}

/**
 * The images queued for the next message.
 */
export function useChatAttachments(): ChatAttachment[] {
  return useSelector(useChat(), selectAttachments)
}

/**
 * Whether a turn is streaming.
 */
export function useChatStatus(): ChatStatus {
  return useSelector(useChat(), selectStatus)
}

/**
 * The configured provider entries (empty means the add-a-provider call to action).
 */
export function useChatProviders(): ChatModels['providers'] {
  return useSelector(useChat(), selectProviders)
}

/**
 * The configured providers, the picker's model options, and the active model.
 */
export function useChatModels(): ChatModels {
  const session = useChat()
  const providers = useSelector(session, selectProviders)
  const modelOptions = useSelector(session, selectModelOptions)
  const activeModel = useSelector(session, selectActiveModel)
  return { providers, modelOptions, activeModel }
}

/**
 * The id of the persisted conversation the transcript belongs to.
 */
export function useActiveConversationId(): string {
  return useSelector(useChat(), selectActiveConversationId)
}
