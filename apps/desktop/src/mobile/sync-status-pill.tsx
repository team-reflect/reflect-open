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
  const keyboardVisible = useKeyboardVisible()

  if (status === null || status.tone === 'ok' || keyboardVisible) {
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
