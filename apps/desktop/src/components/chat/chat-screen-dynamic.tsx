import { lazy, Suspense, type ReactElement } from 'react'
import { LoadingScreen } from '@/components/loading-screen'

const ChatScreen = lazy(() =>
  import('@/components/chat/chat-screen').then((module) => ({ default: module.ChatScreen })),
)

export function ChatScreenDynamic(): ReactElement {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <ChatScreen />
    </Suspense>
  )
}
