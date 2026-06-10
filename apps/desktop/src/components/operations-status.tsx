import type { ReactElement } from 'react'
import { useOperations } from '@/lib/operations'

/**
 * The global status surface (foundations hardening): a small, unobtrusive
 * stack for background operations that outlive their pane — the rename
 * rewrite is the first tenant; indexing/sync states can migrate here as
 * they're touched. Renders nothing when idle.
 */
export function OperationsStatus(): ReactElement | null {
  const operations = useOperations()
  if (operations.length === 0) {
    return null
  }
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {operations.map((operation) => (
        <div
          key={operation.id}
          role="status"
          className="rounded-md border border-black/10 bg-[var(--surface,var(--background,#fff))] px-3 py-2 text-xs shadow-lg dark:border-white/10"
        >
          <span className="block font-medium">{operation.label}</span>
          {operation.progress !== null ? (
            <span className="block text-[color:var(--text-muted)]">
              {operation.progress.done}/{operation.progress.total}
            </span>
          ) : null}
          {operation.status === 'failed' ? (
            <span className="block text-red-600 dark:text-red-400">{operation.error}</span>
          ) : null}
        </div>
      ))}
    </div>
  )
}
