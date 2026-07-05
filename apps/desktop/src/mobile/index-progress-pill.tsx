import { useSyncExternalStore, type ReactElement } from 'react'
import { getIndexProgress, subscribeIndexProgress } from '@/lib/index-progress'
import { useKeyboardVisible } from '@/mobile/use-keyboard'

/**
 * Below this listing size the pass finishes before a pill is worth showing —
 * rendering one would just flash on every open.
 */
const MIN_TOTAL = 100

/**
 * Progress for the running index pass, in the sync pill's shape. Appears only
 * during a pass over a large graph — the first open of a synced-down graph
 * indexes every note, which on a big graph takes long enough that a silent
 * shell reads as frozen. Subscribes to the module store directly (not graph
 * context) so per-tick updates re-render this pill alone.
 */
export function IndexProgressPill(): ReactElement | null {
  const progress = useSyncExternalStore(subscribeIndexProgress, getIndexProgress)
  const keyboardVisible = useKeyboardVisible()

  if (progress === null || progress.total < MIN_TOTAL || keyboardVisible) {
    return null
  }

  return (
    <div
      role="status"
      className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium tabular-nums shadow-sm"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" />
      Preparing notes… {progress.done.toLocaleString()} of {progress.total.toLocaleString()}
    </div>
  )
}
