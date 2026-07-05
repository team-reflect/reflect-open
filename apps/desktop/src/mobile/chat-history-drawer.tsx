import type { ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { hasBridge, listChatConversations } from '@reflect/core'
import { Check, Trash2 } from 'lucide-react'
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer'
import { CHAT_QUERY_SCOPE } from '@/lib/query-client'
import { useChatSession } from '@/providers/chat-provider'
import { useGraph } from '@/providers/graph-provider'

interface ChatHistoryDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The mobile conversation history: desktop's dropdown as a bottom sheet.
 * Tapping a conversation loads it and closes the sheet; the trash button is
 * always visible (no hover tier on touch) and deleting the active
 * conversation starts a fresh chat, exactly as on desktop — both semantics
 * come from the session, this is only the touch shell.
 */
export function ChatHistoryDrawer({ open, onOpenChange }: ChatHistoryDrawerProps): ReactElement {
  const { graph, indexGeneration } = useGraph()
  const { activeConversationId, openConversation, deleteConversation } = useChatSession()

  const enabled = hasBridge() && indexGeneration !== null
  const { data: conversations } = useQuery({
    // The graph root is part of the key: conversations belong to one graph,
    // and a graph switch must never serve the previous graph's cached list.
    queryKey: [CHAT_QUERY_SCOPE, 'conversations', graph?.root],
    queryFn: () => listChatConversations(),
    enabled: enabled && open,
  })

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent aria-label="Chat history">
        <DrawerTitle className="px-4 pt-1">History</DrawerTitle>
        <div className="max-h-[60dvh] overflow-y-auto px-4 pb-8 pt-4">
          {conversations === undefined || conversations.length === 0 ? (
            <p className="py-6 text-center text-sm text-text-muted">No past chats</p>
          ) : (
            <ul className="overflow-hidden rounded-xl bg-surface">
              {conversations.map((conversation) => {
                const current = conversation.id === activeConversationId
                return (
                  <li
                    key={conversation.id}
                    className="flex items-center gap-2 border-b border-border pl-4 pr-1 last:border-b-0"
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 py-3 text-left"
                      onClick={() => {
                        if (!current) {
                          void openConversation(conversation.id)
                        }
                        onOpenChange(false)
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">{conversation.title}</span>
                      <span className="shrink-0 text-xs text-text-muted">
                        {formatDistanceToNow(conversation.updatedMs, { addSuffix: true })}
                      </span>
                    </button>
                    {current ? (
                      <span className="flex size-10 shrink-0 items-center justify-center">
                        <Check aria-hidden className="size-4 text-primary" />
                      </span>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Delete “${conversation.title}”`}
                        className="flex size-10 shrink-0 items-center justify-center text-text-muted"
                        onClick={() => void deleteConversation(conversation.id)}
                      >
                        <Trash2 aria-hidden className="size-4" />
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
