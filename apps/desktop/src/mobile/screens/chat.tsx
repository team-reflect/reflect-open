import { useState, type ReactElement } from 'react'
import { ChevronLeft, History, MessageSquare, Plus } from 'lucide-react'
import { ChatTurnList } from '@/components/chat/chat-turn-list.tsx'
import { Button } from '@/components/ui/button.tsx'
import { MobileChatComposer } from '@/mobile/chat-composer.tsx'
import { ChatHistoryDrawer } from '@/mobile/chat-history-drawer.tsx'
import { MobileTopBar, MobileTopBarIconButton, MobileTopBarRow } from '@/mobile/top-bar.tsx'
import { useChatActions, useChatProviders, useHasChatTurns } from '@/providers/chat-provider.tsx'
import { useRouter } from '@/routing/router.tsx'

/**
 * The Chat screen (Plan 23): desktop's dedicated chat view as a card pushed
 * over All, where the search field's Ask row and the Chat button open it —
 * the transcript reuses desktop's turn components wholesale (tool chips,
 * settled-markdown citations that navigate), over a mobile composer and
 * bottom-sheet history/model pickers. The conversation and draft live in
 * the graph's `ChatSession` above the screen, so going back and coming in
 * again loses nothing. Back pops the stack (a cold entry lands on today, as
 * the back-swipe does). With no AI provider configured the screen is one
 * call-to-action into Settings, where keys are added per device.
 */
export function MobileChat(): ReactElement {
  const providers = useChatProviders()
  const hasTurns = useHasChatTurns()
  const { newChat } = useChatActions()
  const { navigate, back, canBack } = useRouter()
  const [historyOpen, setHistoryOpen] = useState(false)
  const hasProvider = providers.length > 0

  return (
    <div className="flex h-full w-screen flex-col pt-safe">
      <MobileTopBar>
        <MobileTopBarRow>
          <MobileTopBarIconButton
            edge="leading"
            aria-label="Back"
            onClick={() => (canBack ? back() : navigate({ kind: 'today' }))}
          >
            <ChevronLeft aria-hidden />
          </MobileTopBarIconButton>
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold">Chat</h1>
          {hasProvider ? (
            <>
              {hasTurns ? (
                <MobileTopBarIconButton aria-label="New chat" onClick={newChat}>
                  <Plus aria-hidden />
                </MobileTopBarIconButton>
              ) : null}
              <MobileTopBarIconButton
                edge="trailing"
                aria-label="Chat history"
                onClick={() => setHistoryOpen(true)}
              >
                <History aria-hidden />
              </MobileTopBarIconButton>
            </>
          ) : null}
        </MobileTopBarRow>
      </MobileTopBar>
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
