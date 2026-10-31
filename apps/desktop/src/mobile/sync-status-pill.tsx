import type { ReactElement } from 'react'
import { getMobileSyncStatus } from '@reflect/app'
import { cn } from '@/lib/utils.ts'
import { useGitSyncContext } from '@/providers/sync-provider.tsx'

/**
 * The sync-status pill (Plan 19, step 10): a small chip that appears only
 * while sync has something to say: `Syncing` during a cycle, `Offline`/`Needs attention` after
 * a failed cycle. The quiet `Up to date` state renders nothing (detail lives
 * in the settings sheet) and it never intercepts touches. Positioning above
 * the tab bar belongs to {@link MobileStatusLayer}.
 */
export function SyncStatusPill(): ReactElement | null {
  const sync = useGitSyncContext()
  const status = getMobileSyncStatus(sync?.state ?? null)

  if (status === null || status.tone === 'ok') {
    return null
  }

  return (
    <div
      role="status"
      className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium shadow-sm"
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 rounded-full',
          // `ok` never reaches here — the pill hides on it above.
          status.tone === 'active' && 'bg-accent motion-safe:animate-pulse',
          status.tone === 'attention' && 'bg-amber-500',
        )}
      />
      {status.label}
    </div>
  )
}
