import { z } from 'zod'
import { getBridge, type Unlisten } from '../ipc/bridge'

/** The Rust iCloud watch's conflict event (Plan 21 Phase 2). */
const ICLOUD_CONFLICTS_EVENT = 'icloud:conflicts'

const payloadSchema = z.array(z.string())

/**
 * Subscribe to the iCloud watch's conflict signal: graph-relative paths the
 * metadata query currently reports as carrying unresolved conflict versions.
 * The signal is a *trigger*, not a state store — it may repeat paths across
 * batches; the subscriber debounces into a conflict sweep, which is where
 * resolution actually happens.
 */
export function subscribeIcloudConflicts(
  handler: (paths: string[]) => void,
): Promise<Unlisten> {
  return getBridge().listen(ICLOUD_CONFLICTS_EVENT, (payload) => {
    const parsed = payloadSchema.safeParse(payload)
    if (parsed.success) {
      handler(parsed.data)
    } else {
      // Contract drift between the Rust event and this schema — loud beats
      // silently never sweeping.
      console.error('invalid icloud:conflicts payload:', parsed.error)
    }
  })
}

/** The Rust iCloud watch's install-failure event (Plan 21). */
const ICLOUD_WATCH_FAILED_EVENT = 'icloud:watch-failed'

/**
 * Subscribe to the watch's install-failure signal. `icloud_watch_start`
 * schedules its native install onto the main thread and returns before it
 * runs, so a failed `startQuery` can't surface through the command's result
 * — it arrives here instead. Rare by construction (Apple documents failure
 * as "already running" or "no predicate", neither possible for a fresh
 * predicated query), but on iOS the query is the sole live change source,
 * so the subscriber should fall back to sweep-based freshness loudly.
 */
export function subscribeIcloudWatchFailed(handler: () => void): Promise<Unlisten> {
  return getBridge().listen(ICLOUD_WATCH_FAILED_EVENT, () => {
    handler()
  })
}
