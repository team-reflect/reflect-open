import type { ReactElement } from 'react'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller'
import { useChatSession } from '@/providers/chat-provider'
import { ChatTurn } from './chat-turn'

/**
 * The conversation column: a centered list of turns inside shadcn's chat
 * scroller, which owns scroll anchoring while a response streams.
 */
export function ChatTurnList(): ReactElement {
  const { turns } = useChatSession()

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport className="px-6" aria-label="Chat conversation">
          {turns.length > 0 ? (
            <div className="mx-auto w-full max-w-2xl">
              <MessageScrollerContent className="gap-6 py-8">
                {turns.map((turn) => (
                  <MessageScrollerItem key={turn.id} messageId={turn.id} scrollAnchor>
                    <ChatTurn turn={turn} />
                  </MessageScrollerItem>
                ))}
              </MessageScrollerContent>
            </div>
          ) : null}
        </MessageScrollerViewport>
        <MessageScrollerButton className="bottom-5" />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}
