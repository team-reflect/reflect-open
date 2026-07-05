import { createContext, useContext } from 'react'
import type {
  AiProviderConfig,
  ChatModelOption,
  ChatModelSelection,
  ChatTurn,
} from '@reflect/core'
import type { ChatAttachment } from '@/lib/chat-attachments'

/**
 * The chat session's public surface — the context `ChatProvider` fills and
 * every chat component (desktop screen and mobile tab alike) consumes via
 * {@link useChatSession}. Split from the provider so the contract reads on
 * its own; the session semantics live with the provider.
 */

export type ChatStatus = 'idle' | 'streaming'

export interface ChatContextValue {
  turns: ChatTurn[]
  status: ChatStatus
  /** Configured provider entries (empty → the add-a-provider CTA). */
  providers: AiProviderConfig[]
  /** Every model the picker offers: each provider's full curated list. */
  modelOptions: ChatModelOption[]
  /**
   * The provider entry + model the next turn calls (`model` already carries
   * the picker's choice) — the persisted last pick or the settings default.
   */
  activeModel: AiProviderConfig | null
  /**
   * Pick the chat model. Persisted (`chatModelSelection` in the settings
   * document), so later sessions start on it; null returns to the app
   * default.
   */
  selectModel: (selection: ChatModelSelection | null) => void
  /**
   * The composer's unsent text. Provider state, not composer state, so it
   * survives the screen unmounting — on mobile every tab switch unmounts the
   * chat screen (Plan 23, contract 7). Cleared by a send that goes through.
   */
  draft: string
  /** Replace the composer draft (the composer's onChange). */
  setDraft: (text: string) => void
  /** Images queued for the next message (dropped or pasted onto the chat). */
  attachments: ChatAttachment[]
  /** Queue image files for the next message. */
  attachImages: (files: File[]) => Promise<void>
  /** Drop one queued image. */
  removeAttachment: (id: string) => void
  /** Send one user message (text, queued images, or both) and stream the turn. */
  send: (text: string) => Promise<void>
  /** Abort the in-flight turn (partial text stays in the transcript). */
  stop: () => void
  /** Leave the conversation in the history and start a fresh one. */
  newChat: () => void
  /** The persisted conversation the transcript belongs to. */
  activeConversationId: string
  /** Load a past conversation from the history. */
  openConversation: (id: string) => Promise<void>
  /** Delete a conversation; deleting the active one starts a fresh chat. */
  deleteConversation: (id: string) => Promise<void>
}

export const ChatContext = createContext<ChatContextValue | null>(null)

/** Access the chat session. Use within a ChatProvider. */
export function useChatSession(): ChatContextValue {
  const context = useContext(ChatContext)
  if (!context) {
    throw new Error('useChatSession must be used within a ChatProvider')
  }
  return context
}
