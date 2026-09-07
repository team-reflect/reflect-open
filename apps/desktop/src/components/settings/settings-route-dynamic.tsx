import { lazy, Suspense, type ReactElement } from 'react'
import { LoadingScreen } from '@/components/loading-screen'

const SettingsRoute = lazy(() =>
  import('@/components/settings/settings-route').then((module) => ({
    default: module.SettingsRoute,
  })),
)

export function SettingsRouteDynamic(): ReactElement {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <SettingsRoute />
    </Suspense>
  )
}
