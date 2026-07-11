import type { ReactElement, ReactNode } from 'react'
import { cn } from '@/lib/utils'

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
 * growing a second scrollbar around a route's own.
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
        'flex h-screen w-screen overflow-hidden bg-surface-app text-text',
        className,
      )}
    >
      {sidebar ? (
        <aside
          id="workspace-sidebar"
          aria-label="Workspace"
          className="relative flex w-[var(--sidebar-width)] shrink-0 flex-col overflow-hidden border-r border-border bg-surface-sunken"
        >
          {sidebar}
          {sidebarEdge}
        </aside>
      ) : null}

      <main className="min-w-0 flex-1 overflow-hidden bg-surface">{children}</main>

      {context ? (
        <aside
          id="context-sidebar"
          aria-label="Context"
          className="relative hidden w-[var(--context-sidebar-width)] shrink-0 border-l border-border bg-surface-sunken lg:block"
        >
          {contextEdge}
          <div className="h-full overflow-auto">{context}</div>
        </aside>
      ) : null}
    </div>
  )
}
