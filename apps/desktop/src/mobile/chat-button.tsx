import type { ReactElement } from 'react'
import { MessageSquare } from 'lucide-react'
import { MobileTopBarIconButton } from '@/mobile/top-bar.tsx'
import { useHasChatTurns } from '@/providers/chat-provider.tsx'
import { useRouter } from '@/routing/router.tsx'

/**
 * The All tab's way into Chat when there is nothing typed to ask: it resumes
 * the current conversation, marked with a dot, or opens an empty one with
 * the composer focused. With no AI provider, Chat shows its setup
 * call-to-action instead.
 */
export function MobileChatButton(): ReactElement {
  const hasTurns = useHasChatTurns()
  const { navigate } = useRouter()

  return (
    <MobileTopBarIconButton
      edge="trailing"
      aria-label="Chat"
      className="relative"
      onClick={() => navigate({ kind: 'chat' }, hasTurns ? undefined : { focusEditor: true })}
    >
      <MessageSquare aria-hidden />
      {hasTurns ? (
        <span
          aria-hidden
          data-testid="chat-in-progress"
          className="absolute top-2 right-2 size-2 rounded-full bg-primary ring-2 ring-background"
        />
      ) : null}
    </MobileTopBarIconButton>
  )
}
