import { useEffect, useRef, type ReactElement } from 'react'
import { useChatSession } from '@/providers/chat-provider'
import { ChatTurn } from './chat-turn'

/**
 * The conversation column: a centered, scrolling list of turns that follows
 * the stream. Auto-scroll is polite — it only sticks to the bottom while the
 * user is already there, so scrolling up to reread is never fought.
 */
export function ChatTurnList(): ReactElement {
  const { turns } = useChatSession()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)

  useEffect(() => {
    const container = scrollRef.current
    if (container && pinnedRef.current) {
      container.scrollTop = container.scrollHeight
    }
  }, [turns])

  return (
    <div
      ref={scrollRef}
      onScroll={(event) => {
        const target = event.currentTarget
        pinnedRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 48
      }}
      className="min-h-0 flex-1 overflow-y-auto px-6"
    >
      {turns.length > 0 && (
        <div className="mx-auto w-full max-w-2xl py-8">
          <div className="flex flex-col gap-6">
            {turns.map((turn) => (
              <ChatTurn key={turn.id} turn={turn} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
