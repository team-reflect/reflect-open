import { useEffect, type ReactElement } from 'react'
import { hasBridge } from '@reflect/core'
import { App } from '@/app'
import { OperationsStatus } from '@/components/operations-status'
import { UpdateToast } from '@/components/update-toast'
import { Toaster } from '@/components/ui/sonner'
import { WindowDragRegion } from '@/components/window-drag-region'
import { TooltipProvider } from '@/components/ui/tooltip'
import { startDeepLinkListener } from '@/lib/deep-links/intake'
import { GraphProvider } from '@/providers/graph-provider'
import { UpdateProvider } from '@/providers/update-provider'

/**
 * The desktop surface tree (split out of `main.tsx` by the Plan 19 platform
 * gate): auto-update checks, the titlebar drag region, and the graph
 * chooser/workspace app — none of which exist on mobile.
 */
export function DesktopRoot(): ReactElement {
  // Deep-link intake starts with the surface, not the workspace: a
  // `reflect://` URL that launched the app (or arrived on the graph chooser)
  // buffers in `intake.ts` until a graph opens. Browser dev has no plugin.
  useEffect(() => {
    if (!hasBridge()) {
      return
    }
    startDeepLinkListener().catch((cause: unknown) => {
      console.error('deep link listener failed to start:', cause)
    })
  }, [])

  return (
    <UpdateProvider>
      <GraphProvider>
        <TooltipProvider>
          <WindowDragRegion />
          <App />
          <Toaster />
          <OperationsStatus />
          <UpdateToast />
        </TooltipProvider>
      </GraphProvider>
    </UpdateProvider>
  )
}
