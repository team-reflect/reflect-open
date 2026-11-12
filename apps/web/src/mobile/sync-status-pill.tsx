import type { ReactElement } from 'react'
import { getMobileSyncStatus, type MobileSyncStatus } from '@reflect/app'
import { useSelector } from '@/lib/use-store.ts'
import { cn } from '@/lib/utils.ts'
import { useGitSyncStore } from '@/providers/sync-provider.tsx'

/**
 * Whether two statuses render the same pill: it shows only the label and the tone.
 */
function isSamePill(a: MobileSyncStatus | null, b: MobileSyncStatus | null): boolean {
  return a === b || (a !== null && b !== null && a.label === b.label && a.tone === b.tone)
}

/**
 * The sync-status pill (Plan 19, step 10): a small chip that appears only
 * while sync has something to say: `Syncing` during a cycle, `Offline`/`Needs attention` after
 * a failed cycle. The quiet `Up to date` state renders nothing (detail lives
 * in the settings sheet) and it never intercepts touches. Positioning above
 * the tab bar belongs to {@link MobileStatusLayer}.
 */
export function SyncStatusPill(): ReactElement | null {
  const status = useSelector(useGitSyncStore(), getMobileSyncStatus, isSamePill)

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
