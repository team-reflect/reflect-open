import { lazy, Suspense, type ReactElement } from 'react'
import { LoadingScreen } from '@/components/loading-screen'

const MobileSettings = lazy(() =>
  import('@/mobile/screens/settings').then((module) => ({ default: module.MobileSettings })),
)

export function MobileSettingsDynamic(): ReactElement {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <MobileSettings />
    </Suspense>
  )
}
