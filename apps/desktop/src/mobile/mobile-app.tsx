import { type ReactElement } from 'react'
import { MobileErrorBoundary } from '@/mobile/mobile-error-boundary'
import { MobileToday } from '@/mobile/screens/today'
import { useGraph } from '@/providers/graph-provider'
import { RouterProvider } from '@/routing/router'

/**
 * Mobile root component (Plan 19 skeleton): the graph provider bootstraps the
 * fixed `Documents/` root automatically, so there is no chooser — just a
 * loading gate into Today. `choosing` only happens when that open failed
 * (the provider parks there with its error), so it renders as an error state.
 *
 * The router mounts per graph exactly as on desktop — the document stack
 * (wiki-link navigation, backlinks) requires it. The skeleton's Today screen
 * doesn't yet *render* route changes; the mobile stack/tab navigation that
 * consumes them is a later Plan 19 step.
 */
export function MobileApp(): ReactElement {
  const { status, graph, error } = useGraph()

  if (status === 'ready' && graph) {
    return (
      <MobileErrorBoundary>
        <RouterProvider key={graph.root}>
          <MobileToday />
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
