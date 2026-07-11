import type { ReactElement } from 'react'
import {
  SIDEBAR_PANEL_IDS,
  useSidebarResize,
  type ResizableSidebarPanel,
} from '@/hooks/use-sidebar-resize'
import { cn } from '@/lib/utils'

const PANEL_LABELS: Record<ResizableSidebarPanel, string> = {
  workspace: 'Resize sidebar',
  context: 'Resize context panel',
}

interface SidebarResizeHandleProps {
  panel: ResizableSidebarPanel
}

/**
 * The draggable divider on a sidebar's inner edge: an 8px invisible hit strip
 * whose 2px edge line tints on hover (after a short delay, so mousing past
 * doesn't flash), while dragging, and on keyboard focus — at rest the aside's
 * hairline border stays the only chrome. A focusable `separator` controlling
 * its aside: arrow keys nudge the divider, Home/End jump the rail to its
 * minimum/maximum width, and double-click resets to the default.
 */
export function SidebarResizeHandle({ panel }: SidebarResizeHandleProps): ReactElement {
  const { width, range, dragging, handlers } = useSidebarResize(panel)

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={PANEL_LABELS[panel]}
      aria-controls={SIDEBAR_PANEL_IDS[panel]}
      aria-valuenow={width}
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      {...handlers}
      className={cn(
        // outline-hidden (not -none) keeps the forced-colors fallback outline
        // for high-contrast users, whom the tinted edge line cannot reach.
        'absolute inset-y-0 z-10 w-2 cursor-col-resize touch-none outline-hidden',
        'after:absolute after:inset-y-0 after:w-0.5 after:transition-colors after:duration-100',
        'hover:after:bg-border-strong hover:after:delay-150 focus-visible:after:bg-accent/40',
        panel === 'workspace' ? 'right-0 after:right-0' : 'left-0 after:left-0',
        dragging && 'after:bg-accent/60 hover:after:bg-accent/60',
      )}
    />
  )
}
