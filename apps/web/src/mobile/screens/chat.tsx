import { useState, type ReactElement } from 'react'
import { MessageSquare } from 'lucide-react'
import { ChatTurnList } from '@/components/chat/chat-turn-list.tsx'
import { Button } from '@/components/ui/button.tsx'
import { MobileChatComposer } from '@/mobile/chat-composer.tsx'
import { ChromeTopBar } from '@/mobile/chrome/chrome-top-bar.tsx'
import { ChatHistoryDrawer } from '@/mobile/chat-history-drawer.tsx'
import { useChatActions, useChatProviders, useHasChatTurns } from '@/providers/chat-provider.tsx'
import { useRouterState, useRouterActions } from '@/routing/router.tsx'
import { useChatIsSection } from '@/mobile/sidebar.ts'

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
  const { canBack, section } = useRouterState()
  // The root of the Chat section has nothing below it to go back to.
  const chatIsSection = useChatIsSection()
  const isRoot = section === 'chat' && chatIsSection
  const { navigate, back } = useRouterActions()
  const [historyOpen, setHistoryOpen] = useState(false)
  const hasProvider = providers.length > 0
  const goBack = (): void => (canBack ? back() : navigate({ kind: 'today' }))

  return (
    <div className="flex h-full w-full flex-col pt-safe">
      <ChromeTopBar
        back={isRoot ? undefined : goBack}
        trailing={
          hasProvider
            ? [
                ...(hasTurns ? [{ id: 'new', title: 'New chat', icon: 'plus' } as const] : []),
                { id: 'history', title: 'Chat history', icon: 'history' },
              ]
            : []
        }
        onAction={(id) => (id === 'new' ? newChat() : setHistoryOpen(true))}
        title="Chat"
      />
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
