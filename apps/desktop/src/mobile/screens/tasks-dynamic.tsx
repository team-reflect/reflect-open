import { lazy, Suspense, type ReactElement } from 'react'
import { LoadingScreen } from '@/components/loading-screen'

const MobileTasks = lazy(() =>
  import('@/mobile/screens/tasks').then((module) => ({ default: module.MobileTasks })),
)

export function MobileTasksDynamic(): ReactElement {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <MobileTasks />
    </Suspense>
  )
}
