import type { ReactElement } from 'react'
import { cn } from '@/lib/utils.ts'
import { useKeyboardVisible } from '@/mobile/use-keyboard.ts'
import { useMobileSyncStatus } from '@/mobile/use-sync-status.ts'

/**
 * The sync-status pill (Plan 19, step 10): a small chip that appears only
 * while sync has something to say: `Syncing` during a cycle, `Offline`/`Needs attention` after
 * a failed cycle. The quiet `Backed up` state renders nothing (detail lives
 * in the settings sheet) and it never intercepts touches. Positioning above
 * the tab bar belongs to {@link MobileStatusLayer}; the keyboard check here
 * backstops the layer's, keeping the pill correct if ever mounted alone.
 */
export function SyncStatusPill(): ReactElement | null {
  const status = useMobileSyncStatus()
  const keyboardVisible = useKeyboardVisible() // FIXME I do not think you need this keyboardVisible at all. SyncStatusPill only has one caller and it seems that caller already checks for keyboardVisible. So this is redundant and can be removed.

  if (status === null || status.tone === 'ok' || keyboardVisible) {
    return null
  }

  // FIXME: just refactor this into an component. do not use useMobileSyncStatus. so that you
  // do not need to expoort a useBackupCountdown function. you can just use the BackupCountdown component directly in the component that needs it.

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
