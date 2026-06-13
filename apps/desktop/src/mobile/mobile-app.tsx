import { type ReactElement } from 'react'
import { MobileErrorBoundary } from '@/mobile/mobile-error-boundary'
import { MobileScreen } from '@/mobile/mobile-screen'
import { useKeyboardHeightVar } from '@/mobile/use-keyboard'
import { useGraph } from '@/providers/graph-provider'
import { RouterProvider } from '@/routing/router'

/**
 * Mobile root component (Plan 19): the graph provider bootstraps the fixed
 * `Documents/` root automatically, so there is no chooser — just a loading
 * gate into the route switch. `choosing` only happens when that open failed
 * (the provider parks there with its error), so it renders as an error state.
 *
 * The router mounts per graph exactly as on desktop; `MobileScreen` renders
 * the current route (daily spine, note pages), so wiki-link and date-link
 * taps navigate for real. The keyboard-height bridge lives here so every
 * screen inherits `--keyboard-height`.
 */
export function MobileApp(): ReactElement {
  const { status, graph, error } = useGraph()
  useKeyboardHeightVar()

  if (status === 'ready' && graph) {
    return (
      <MobileErrorBoundary>
        <RouterProvider key={graph.root}>
          <MobileScreen />
        </RouterProvider>
      </MobileErrorBoundary>
    )
  }

  if (status === 'choosing') {
    return (
      <div className="flex h-dvh w-screen flex-col items-center justify-center gap-2 px-8 text-center">
        <p className="text-sm font-medium">Couldn’t open your notes</p>
        <p className="text-sm text-text-muted">{error ?? 'Unknown error'}</p>
      </div>
    )
  }

  return (
    <div className="flex h-dvh w-screen items-center justify-center text-sm text-text-muted">
      Loading…
    </div>
  )
}
