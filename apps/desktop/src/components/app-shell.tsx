import type { ReactElement, ReactNode } from 'react'
import { cn } from '@/lib/utils.ts'

interface AppShellProps {
  /** The workspace sidebar; omit to render the note pane edge-to-edge. */
  sidebar?: ReactNode
  /** Resize affordance for the workspace aside's inner edge (a separator). */
  sidebarEdge?: ReactNode
  /** Right context panel (the AI copilot lands here in Plan 10). */
  context?: ReactNode
  /** Resize affordance for the context aside's inner edge (a separator). */
  contextEdge?: ReactNode
  /** The center note pane. */
  children: ReactNode
  className?: string
}

/** Every column clears the frame's top and bottom insets (none on desktop). */
const INSETS = 'pt-(--app-shell-inset-top,0px) pb-(--app-shell-inset-bottom,0px)'

/**
 * The application frame, in the original app's shape: a sunken sidebar beside
 * the raised note pane, no header bar — the document is the chrome. Layout
 * and landmark regions only; what fills the slots (and whether the sidebar
 * shows at all) is the workspace's business — including the edge slots,
 * which the workspace fills with resize handles. The aside widths read the
 * `--sidebar-width` / `--context-sidebar-width` root variables, which
 * `SidebarWidthEffect` derives from the persisted preferences and the
 * viewport. The context edge renders before the panel's scroller so the
 * separator precedes the panel's controls in tab order, matching its visual
 * position on the aside's leading edge. The frame never scrolls: every route
 * mounts its own scroll container, so the center region clips instead of
 * growing a second scrollbar around a route's own. It fills the window unless
 * `--app-shell-height` / `--app-shell-width` say otherwise, and each column
 * clears `--app-shell-inset-top` / `--app-shell-inset-bottom` inside its own
 * background: the iPad sets them to the safe-area insets, so the columns run
 * under the status bar or the window controls without a band across the top.
 */
export function AppShell({
  sidebar,
  sidebarEdge,
  context,
  contextEdge,
  children,
  className,
}: AppShellProps): ReactElement {
  return (
    <div
      className={cn(
        'flex h-(--app-shell-height,100vh) w-(--app-shell-width,100vw) overflow-hidden bg-surface-app text-text',
        className,
      )}
    >
      {sidebar ? (
        <aside
          id="workspace-sidebar"
          aria-label="Workspace"
          className={cn(
            'relative flex w-[var(--sidebar-width)] shrink-0 flex-col overflow-hidden border-r border-border bg-surface-sunken',
            INSETS,
          )}
        >
          {sidebar}
          {sidebarEdge}
        </aside>
      ) : null}

      <main className={cn('min-w-0 flex-1 overflow-hidden bg-surface', INSETS)}>{children}</main>

      {context ? (
        <aside
          id="context-sidebar"
          aria-label="Context"
          className={cn(
            'relative hidden w-[var(--context-sidebar-width)] shrink-0 border-l border-border bg-surface-sunken lg:block',
            INSETS,
          )}
        >
          {contextEdge}
          <div className="h-full overflow-auto">{context}</div>
        </aside>
      ) : null}
    </div>
  )
}
