import { type ReactElement } from 'react'
import { MobileErrorBoundary } from '@/mobile/mobile-error-boundary'
import { MobileOnboardingScreen } from '@/mobile/onboarding-screen'
import { MobileShell } from '@/mobile/mobile-shell'
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
  const { status, graph, error, needsOnboarding } = useGraph()
  useKeyboardHeightVar()

  if (status === 'ready' && graph) {
    return (
      <MobileErrorBoundary>
        <RouterProvider key={graph.root}>
          <MobileShell />
        </RouterProvider>
      </MobileErrorBoundary>
    )
  }

  // First run: the provider derived the fixed root but deferred opening it
  // until the user chooses how to start (Plan 19, step 6). Checked before the
  // 'choosing' error branch — onboarding parks at 'choosing' deliberately.
  if (needsOnboarding) {
    return <MobileOnboardingScreen />
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
