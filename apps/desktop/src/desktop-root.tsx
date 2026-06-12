import { type ReactElement } from 'react'
import { App } from '@/app'
import { WindowDragRegion } from '@/components/window-drag-region'
import { TooltipProvider } from '@/components/ui/tooltip'
import { GraphProvider } from '@/providers/graph-provider'
import { UpdateProvider } from '@/providers/update-provider'

/**
 * The desktop surface tree (split out of `main.tsx` by the Plan 19 platform
 * gate): auto-update checks, the titlebar drag region, and the graph
 * chooser/workspace app — none of which exist on mobile.
 */
export function DesktopRoot(): ReactElement {
  return (
    <UpdateProvider>
      <GraphProvider>
        <TooltipProvider>
          <WindowDragRegion />
          <App />
        </TooltipProvider>
      </GraphProvider>
    </UpdateProvider>
  )
}
