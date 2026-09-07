import { lazy, Suspense, type ComponentProps, type ReactElement } from 'react'
import { LoadingScreen } from '@/components/loading-screen'
import type { AllNotesScreen as AllNotesScreenComponent } from '@/components/all-notes/all-notes-screen'

const AllNotesScreen = lazy(() =>
  import('@/components/all-notes/all-notes-screen').then((module) => ({
    default: module.AllNotesScreen,
  })),
)

export function AllNotesScreenDynamic(
  props: ComponentProps<typeof AllNotesScreenComponent>,
): ReactElement {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <AllNotesScreen {...props} />
    </Suspense>
  )
}
