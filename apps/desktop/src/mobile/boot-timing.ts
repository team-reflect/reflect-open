/**
 * Temporary boot instrumentation for the iOS paywall gate.
 *
 * It answers one question: on a cold start, is the `Loading…` screen the
 * paywall gate waiting on StoreKit, or is it the graph open? The gate holds
 * that screen until the two entitlement queries and the settings document
 * settle, and a production-only paywall would add the install-channel probe
 * (`AppTransaction.shared`, which can go to the App Store server on a first
 * launch) to the same wait. Caching those answers is only worth building if
 * they are what the user is actually looking at.
 *
 * Every entry is logged to the console (Safari Web Inspector) and kept in
 * memory so Settings' debug section can show the numbers on device, where no
 * inspector is attached. Delete this module and its call sites once the
 * numbers are recorded.
 */

export interface BootTiming {
  /** What happened. */
  readonly label: string
  /** Milliseconds since the webview started loading the page. */
  readonly at: number
  /** How long the awaited call took, or null for a plain mark. */
  readonly duration: number | null
}

// A new array per entry: `useSyncExternalStore` compares snapshots by
// identity, so mutating one in place would never re-render the debug list.
let timings: readonly BootTiming[] = []
const listeners = new Set<() => void>()

function push(entry: BootTiming): void {
  timings = [...timings, entry]
  const duration = entry.duration === null ? '' : ` (took ${entry.duration}ms)`
  console.log(`[boot] +${entry.at}ms ${entry.label}${duration}`)
  for (const listener of listeners) {
    listener()
  }
}

/** Record that something happened, with no duration of its own. */
export function markBootTiming(label: string): void {
  push({ label, at: Math.round(performance.now()), duration: null })
}

/** Run `run`, recording how long it took. Failures are recorded and rethrown. */
export async function measureBootTiming<T>(label: string, run: () => Promise<T>): Promise<T> {
  const start = performance.now()
  try {
    const value = await run()
    push({
      label,
      at: Math.round(performance.now()),
      duration: Math.round(performance.now() - start),
    })
    return value
  } catch (error) {
    push({
      label: `${label} failed`,
      at: Math.round(performance.now()),
      duration: Math.round(performance.now() - start),
    })
    throw error
  }
}

/** Everything recorded so far, oldest first. */
export function getBootTimings(): readonly BootTiming[] {
  return timings
}

/** Subscribe to new entries (for `useSyncExternalStore`). */
export function subscribeBootTimings(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
