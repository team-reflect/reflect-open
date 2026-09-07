import { lazy, Suspense, type ReactElement } from 'react'
import { LoadingScreen } from '@/components/loading-screen'

const MobileGraphs = lazy(() =>
  import('@/mobile/screens/graphs').then((module) => ({ default: module.MobileGraphs })),
)

export function MobileGraphsDynamic(): ReactElement {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <MobileGraphs />
    </Suspense>
  )
}
