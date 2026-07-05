import { useState, type ReactElement } from 'react'
import { History, MessageSquare, Plus } from 'lucide-react'
import { ChatTurnList } from '@/components/chat/chat-turn-list'
import { Button } from '@/components/ui/button'
import { MobileChatComposer } from '@/mobile/chat-composer'
import { ChatHistoryDrawer } from '@/mobile/chat-history-drawer'
import { useChatSession } from '@/providers/chat-provider'
import { useRouter } from '@/routing/router'

/**
 * The Chat tab (Plan 23): desktop's dedicated chat view as a root tab —
 * the transcript reuses desktop's turn components wholesale (tool chips,
 * settled-markdown citations that navigate), over a mobile composer and
 * bottom-sheet history/model pickers. The conversation and draft live in
 * {@link useChatSession} above the screen, so switching tabs and coming back
 * loses nothing. With no AI provider configured the tab is one
 * call-to-action into Settings, where keys are added per device.
 */
export function MobileChat(): ReactElement {
  const { providers, turns, newChat } = useChatSession()
  const { navigate } = useRouter()
  const [historyOpen, setHistoryOpen] = useState(false)
  const hasProvider = providers.length > 0

  return (
    <div
      className="flex h-full w-screen flex-col"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-border pl-4 pr-1">
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">Chat</h1>
        {hasProvider ? (
          <>
            {turns.length > 0 ? (
              <Button variant="ghost" size="icon" aria-label="New chat" onClick={newChat}>
                <Plus aria-hidden />
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Chat history"
              onClick={() => setHistoryOpen(true)}
            >
              <History aria-hidden />
            </Button>
          </>
        ) : null}
      </header>
      {hasProvider ? (
        <>
          <ChatTurnList />
          <MobileChatComposer />
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center px-6">
          <div className="flex max-w-sm flex-col items-center text-center">
            <MessageSquare aria-hidden strokeWidth={1.5} className="size-8 text-text-muted" />
            <h2 className="mt-4 text-lg font-semibold text-text">Chat with your notes</h2>
            <p className="mt-2 text-sm text-text-muted">
              Add an AI provider to start chatting. Reflect calls the provider directly with your
              own key — it stays in the device keychain, and private notes are never sent.
            </p>
            <Button className="mt-5" onClick={() => navigate({ kind: 'settings' })}>
              Add an AI provider
            </Button>
          </div>
        </div>
      )}
      <ChatHistoryDrawer open={historyOpen} onOpenChange={setHistoryOpen} />
    </div>
  )
}
