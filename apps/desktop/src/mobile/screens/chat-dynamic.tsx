import { lazy, Suspense, type ReactElement } from 'react'
import { LoadingScreen } from '@/components/loading-screen'

const MobileChat = lazy(() =>
  import('@/mobile/screens/chat').then((module) => ({ default: module.MobileChat })),
)

export function MobileChatDynamic(): ReactElement {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <MobileChat />
    </Suspense>
  )
}
