/**
 * The shared lifecycle for a background reconcile loop — capture enrichment
 * ({@link createCaptureController}), audio-memo transcription
 * ({@link createTranscriptionReconciler}), and asset descriptions
 * ({@link createAssetDescribeController}) are all the same shape: a
 * generation-pinned, single-flight pass driven by watcher/focus/online events.
 * The loop guards, wake wiring, and teardown are identical and breed bugs inside
 * a React effect seam, so they live here once. Each feature supplies its own
 * `pass` body and registers its own triggers via {@link BackgroundReconciler.onDispose}.
 */

/**
 * One iteration of a feature's reconcile work. Receives the loop's `isStale`
 * gate to thread into its own reads/writes (and to bail between awaits). Return
 * `'stop'` to end the loop immediately, even if a follow-up was queued mid-pass
 * (e.g. a transient provider failure that should wait for the next external
 * trigger rather than spin); return `void` to keep draining queued follow-ups.
 */
export type ReconcilePass = (isStale: () => boolean) => Promise<void | 'stop'>

export interface BackgroundReconcilerOptions {
  /**
   * The loop body — one pass of work. Invoked repeatedly while a trigger landed
   * mid-pass, until none is queued (or it returns `'stop'`). Use {@link
   * BackgroundReconciler.isStale} as the pass's own abort gate.
   */
  pass: ReconcilePass
  /**
   * Runs in the loop's `finally`, once it drains — e.g. clearing a "working"
   * flag. Always runs after a pass sequence, even on `'stop'` or a throw.
   */
  onSettled?: () => void
}

export interface BackgroundReconciler {
  /** Request a pass; if one is running, queue exactly one follow-up after it. */
  schedule(): void
  /** True once {@link dispose} has run — the `pass` body's `isStale` gate. */
  isStale(): boolean
  /** Retry the loop on window `focus` / `online` (the network's natural signals). */
  retryOnWake(): void
  /**
   * Register a teardown to run on {@link dispose} (an `unlisten`, etc.). Runs
   * immediately if already disposed, so a subscription that resolves after
   * teardown is still cleaned up.
   */
  onDispose(teardown: () => void): void
  /** Stop the loop (its next gate aborts the in-flight pass) and run teardowns. */
  dispose(): void
}

/**
 * Build a single-flight background reconcile loop. `dispose()` is terminal: it
 * flips the stale gate the running pass observes and runs every registered
 * teardown exactly once.
 */
export function createBackgroundReconciler(
  options: BackgroundReconcilerOptions,
): BackgroundReconciler {
  let disposed = false
  let running = false
  /** A trigger landed mid-pass; run exactly one follow-up after it. */
  let queued = false
  const disposers: Array<() => void> = []

  async function run(): Promise<void> {
    if (running) {
      queued = true
      return
    }
    running = true
    try {
      do {
        queued = false
        if ((await options.pass(() => disposed)) === 'stop') {
          break // keep any queued follow-up for the next external trigger
        }
      } while (queued && !disposed)
    } finally {
      running = false
      options.onSettled?.()
    }
  }

  function schedule(): void {
    if (!disposed) {
      void run()
    }
  }

  return {
    schedule,
    isStale: () => disposed,
    retryOnWake() {
      window.addEventListener('focus', schedule)
      window.addEventListener('online', schedule)
      disposers.push(
        () => window.removeEventListener('focus', schedule),
        () => window.removeEventListener('online', schedule),
      )
    },
    onDispose(teardown) {
      if (disposed) {
        teardown()
        return
      }
      disposers.push(teardown)
    },
    dispose() {
      disposed = true
      for (const teardown of disposers.splice(0)) {
        teardown()
      }
    },
  }
}
