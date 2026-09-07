import { lazy, Suspense, type ComponentProps, type ReactElement } from 'react'
import { LoadingScreen } from '@/components/loading-screen'
import type { MobileAllNotes as MobileAllNotesComponent } from '@/mobile/screens/all-notes'

const MobileAllNotes = lazy(() =>
  import('@/mobile/screens/all-notes').then((module) => ({ default: module.MobileAllNotes })),
)

export function MobileAllNotesDynamic(
  props: ComponentProps<typeof MobileAllNotesComponent>,
): ReactElement {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <MobileAllNotes {...props} />
    </Suspense>
  )
}
