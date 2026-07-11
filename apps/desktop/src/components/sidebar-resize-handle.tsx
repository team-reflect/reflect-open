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
 * whose 2px edge line fades in on a lingered hover, while dragging, and on
 * keyboard focus — at rest the aside's hairline border stays the only chrome.
 * The states follow the design system's restraint rules: hover is a quiet
 * grey wash (border-strong at 60% — dark mode lands on V1's exact .03 hover
 * opacity) revealed only after the slow-motion delay, so mouse traffic past
 * the edge never flickers; the cursor alone signals the affordance
 * immediately. Indigo is reserved for the active states — dragging and
 * keyboard focus — which appear without delay. A focusable `separator`
 * controlling its aside: arrow keys nudge the divider, Home/End jump the rail
 * to its minimum/maximum width, and double-click resets to the default.
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
        'after:absolute after:inset-y-0 after:w-0.5 after:bg-border-strong after:opacity-0 after:transition-opacity after:duration-150',
        'hover:after:opacity-60 hover:after:delay-300',
        'focus-visible:after:bg-accent focus-visible:after:opacity-40 focus-visible:after:delay-0',
        panel === 'workspace' ? 'right-0 after:right-0' : 'left-0 after:left-0',
        dragging && 'after:bg-accent after:opacity-60 hover:after:delay-0',
      )}
    />
  )
}
