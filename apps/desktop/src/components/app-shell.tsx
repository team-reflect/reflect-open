import type { ReactElement, ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface AppShellProps {
  /** The workspace sidebar; omit to render the note pane edge-to-edge. */
  sidebar?: ReactNode
  /** Right context panel (the AI copilot lands here in Plan 10). */
  context?: ReactNode
  /** The center note pane. */
  children: ReactNode
  className?: string
}

/**
 * The application frame, in the original app's shape: a sunken sidebar beside
 * the raised note pane, no header bar — the document is the chrome. Layout
 * and landmark regions only; what fills the slots (and whether the sidebar
 * shows at all) is the workspace's business. The frame never scrolls: every
 * route mounts its own scroll container, so the center region clips instead
 * of growing a second scrollbar around a route's own.
 */
export function AppShell({ sidebar, context, children, className }: AppShellProps): ReactElement {
  return (
    <div
      className={cn(
        'flex h-screen w-screen overflow-hidden bg-surface-app text-text',
        className,
      )}
    >
      {sidebar ? (
        <aside
          aria-label="Workspace"
          className="flex w-[var(--sidebar-width)] shrink-0 flex-col overflow-hidden border-r border-border bg-surface-sunken"
        >
          {sidebar}
        </aside>
      ) : null}

      <main className="min-w-0 flex-1 overflow-hidden bg-surface">{children}</main>

      {context ? (
        <aside
          aria-label="Context"
          className="hidden w-80 shrink-0 overflow-auto border-l border-border bg-surface-sunken lg:block"
        >
          {context}
        </aside>
      ) : null}
    </div>
  )
}
