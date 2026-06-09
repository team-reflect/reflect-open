import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface AppShellProps {
  /** Left navigation rail content. */
  rail?: ReactNode
  /** Right context sidebar content (the AI copilot lands here in Plan 10). */
  sidebar?: ReactNode
  /** The center note pane. */
  children: ReactNode
  className?: string
}

/**
 * The three-region application frame: a left navigation rail, the center note
 * pane, and an optional right context sidebar. Layout and focus regions only —
 * no business logic. Keyboard navigation between regions is wired in Plan 06.
 */
export function AppShell({ rail, sidebar, children, className }: AppShellProps) {
  return (
    <div className={cn('flex h-screen w-screen overflow-hidden', className)}>
      <nav
        aria-label="Primary"
        className="flex w-14 shrink-0 flex-col items-center gap-2 border-r border-black/10 py-3 dark:border-white/10"
      >
        {rail}
      </nav>

      <main className="min-w-0 flex-1 overflow-auto">{children}</main>

      {sidebar ? (
        <aside
          aria-label="Context"
          className="hidden w-80 shrink-0 overflow-auto border-l border-black/10 lg:block dark:border-white/10"
        >
          {sidebar}
        </aside>
      ) : null}
    </div>
  )
}
