import { useEffect, type ReactElement } from 'react'
import { App } from '@/app.tsx'
import { AppErrorBoundary } from '@/components/app-error-boundary.tsx'
import { attachOperationToasts } from '@/components/operation-toasts.ts'
import { OutdatedWebEngineBanner } from '@/components/outdated-web-engine-banner.tsx'
import { Toaster } from '@/components/ui/toast.tsx'
import { WindowDragRegion } from '@/components/window-drag-region.tsx'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { GraphProvider } from '@/providers/graph-provider.tsx'
import { SidebarWidthEffect } from '@/providers/sidebar-width.tsx'
import { UpdateProvider } from '@/providers/update-provider.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

/**
 * The desktop surface tree (split out of `main.tsx` by the Plan 19 platform
 * gate): auto-update checks, the titlebar drag region, and the graph
 * chooser/workspace app — none of which exist on mobile.
 */
export function DesktopRoot(): ReactElement {
  const { noteMove, platform, logger, deepLinkIntake } = useCoreServices()
  const { operations } = useAppServices()
  // Deep-link intake starts with the surface, not the workspace: a
  // `reflect://` URL that launched the app (or arrived on the graph chooser)
  // buffers in `intake.ts` until a graph opens. Browser dev has no plugin.
  // A note window's intake has no OS source: the plugin's event stream reaches
  // every webview, and a ⌘-clicked note window must not also navigate itself
  // on OS-delivered URLs (in-note `reflect://` clicks still work — the intake
  // and the handler are per-webview state).
  useEffect(() => {
    if (!platform.isNativeShell) {
      return
    }
    deepLinkIntake.startListener().catch((cause: unknown) => {
      logger.error('deep link listener failed to start:', cause)
    })
  }, [deepLinkIntake, platform, logger])

  // Renames commit in whichever window drove them (a title edit works in
  // note windows too) and broadcast on `note:moved` — EVERY window follows,
  // or its open sessions and router history keep the dead path. The origin
  // window also followed in-process; the echo is idempotent (the session no
  // longer matches `from`, and re-routing an absent entry is a no-op).
  useEffect(() => noteMove.followNativeMoves(), [noteMove])

  // Every desktop window mirrors its own operations store into toasts (the
  // store is per-webview, matching the per-window mount this replaces). The
  // effect only ties the subscription to the window's lifetime; the toast
  // calls themselves run inside the store mutations that report the work.
  useEffect(() => attachOperationToasts(operations, logger), [operations, logger])

  return (
    <AppErrorBoundary>
      <UpdateProvider>
        <GraphProvider>
          <TooltipProvider>
            <SidebarWidthEffect />
            <WindowDragRegion />
            <App />
            <OutdatedWebEngineBanner />
            <Toaster />
          </TooltipProvider>
        </GraphProvider>
      </UpdateProvider>
    </AppErrorBoundary>
  )
}
