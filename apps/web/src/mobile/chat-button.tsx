import { useHasChatTurns } from '@/providers/chat-provider.tsx'
import type { ChromeButton } from '@/mobile/chrome/screen-chrome.ts'
import { useRouterActions } from '@/routing/router.tsx'

/**
 * The All tab's way into Chat: it resumes the current conversation, marked
 * with a dot, or opens an empty one with the composer focused. With no AI
 * provider, Chat shows its setup call-to-action instead.
 */
export function useChatButton(): { button: ChromeButton; open: () => void } {
  const hasTurns = useHasChatTurns()
  const { navigate } = useRouterActions()
  return {
    button: { id: 'chat', title: 'Chat', icon: hasTurns ? 'chat-active' : 'chat' },
    open: () => navigate({ kind: 'chat', conversationId: null }, { focusEditor: !hasTurns }),
  }
}
