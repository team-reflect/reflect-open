import type { ReactElement } from 'react'
import { cn } from '@/lib/utils'
import { useKeyboardVisible } from '@/mobile/use-keyboard'
import { useMobileSyncStatus } from '@/mobile/use-sync-status'

/**
 * The floating sync-status pill (Plan 19, step 10): a small viewport-anchored
 * chip above the tab bar that appears only while sync has something to say —
 * `Syncing` during a cycle, `Needs review` while any note carries conflict
 * markers, `Offline`/`Needs attention` after a failed cycle. The quiet
 * `Backed up` state renders nothing (detail lives in the settings sheet), it
 * never intercepts touches, and it yields to the software keyboard.
 */
export function SyncStatusPill(): ReactElement | null {
  const status = useMobileSyncStatus()
  const keyboardVisible = useKeyboardVisible()

  if (status === null || status.tone === 'ok' || keyboardVisible) {
    return null
  }

  return (
    // `position: fixed` elements are viewport-anchored, so this one places
    // itself above the tab bar via the height the bar publishes (the shell
    // root's keyboard yield doesn't apply — hence the keyboard check above;
    // the safe-area fallback covers surfaces without a tab bar).
    <div
      className="pointer-events-none fixed inset-x-0 z-50 flex justify-center"
      style={{
        bottom: 'calc(var(--mobile-tab-bar-height, env(safe-area-inset-bottom, 0px)) + 0.75rem)',
      }}
    >
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
    </div>
  )
}
