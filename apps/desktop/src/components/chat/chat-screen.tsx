import type { ReactElement } from 'react'
import { MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useChatSession } from '@/providers/chat-provider'
import { useRouter } from '@/routing/router'
import { ChatInput } from './chat-input'
import { ChatTurnList } from './chat-turn-list'

/**
 * The dedicated chat view (Plan 10, revised: a full route, not a side panel).
 * Read-only first wave: the assistant answers questions grounded in the
 * graph via search/read tools and cites notes as wiki links — it never
 * writes. With no AI provider configured the view is one call-to-action into
 * Settings; the conversation itself lives in {@link useChatSession}, so
 * navigating away and back keeps it.
 */
export function ChatScreen(): ReactElement {
  const { providers } = useChatSession()
  const { navigate } = useRouter()

  if (providers.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="flex max-w-sm flex-col items-center text-center">
          <MessageSquare aria-hidden strokeWidth={1.5} className="size-8 text-text-muted" />
          <h2 className="mt-4 text-lg font-semibold text-text">Chat with your notes</h2>
          <p className="mt-2 text-sm text-text-muted">
            Add an AI provider to start chatting. Reflect calls the provider directly with your
            own key — it stays in the system keychain, and private notes are never sent.
          </p>
          <Button className="mt-5" onClick={() => navigate({ kind: 'settings' })}>
            Add an AI provider
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatTurnList />
      <ChatInput />
    </div>
  )
}
