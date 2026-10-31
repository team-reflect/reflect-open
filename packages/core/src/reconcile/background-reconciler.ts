import type { ActivityPort } from '../ports/activity-port.ts'

/**
 * A generation-pinned, single-flight background reconcile loop driven by
 * watcher, focus, and online events. The loop guards, wake wiring, and
 * teardown live here once; each feature supplies its own `pass` body and
 * registers its own triggers via {@link BackgroundReconciler.onDispose}.
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
   * The loop body, one pass of work. Invoked repeatedly while a trigger landed
   * mid-pass, until none is queued (or it returns `'stop'`). Use {@link
   * BackgroundReconciler.isStale} as the pass's own abort gate.
   */
  pass: ReconcilePass
  /**
   * Runs in the loop's `finally`, once it drains, e.g. clearing a "working"
   * flag. Always runs after a pass sequence, even on `'stop'` or a throw.
   */
  onSettled?: () => void
}

export interface BackgroundReconciler {
  /**
   * Request a pass; if one is running, queue exactly one follow-up after it.
   */
  schedule(): void
  /**
   * True once {@link dispose} has run: the `pass` body's `isStale` gate.
   */
  isStale(): boolean
  /**
   * Retry the loop on window `focus` / `online` (the network's natural signals).
   */
  retryOnWake(): void
  /**
   * Register a teardown to run on {@link dispose} (an `unlisten`, etc.). Runs
   * immediately if already disposed, so a subscription that resolves after
   * teardown is still cleaned up.
   */
  onDispose(teardown: () => void): void
  /**
   * Stop the loop (its next gate aborts the in-flight pass) and run teardowns.
   */
  dispose(): void
}

/**
 * Builds {@link BackgroundReconciler} loops.
 */
export interface BackgroundReconcilerFactory {
  /**
   * Build a single-flight background reconcile loop. `dispose()` is terminal:
   * it flips the stale gate the running pass observes and runs every
   * registered teardown exactly once.
   */
  create(options: BackgroundReconcilerOptions): BackgroundReconciler
}

export interface BackgroundReconcilerFactoryDeps {
  readonly activity: ActivityPort
}

class BackgroundReconcilerImpl implements BackgroundReconciler {
  readonly #activity: ActivityPort
  readonly #options: BackgroundReconcilerOptions
  #disposed = false
  #running = false
  /**
   * A trigger landed mid-pass; run exactly one follow-up after it.
   */
  #queued = false
  readonly #disposers: Array<() => void> = []

  constructor(activity: ActivityPort, options: BackgroundReconcilerOptions) {
    this.#activity = activity
    this.#options = options
  }

  schedule(): void {
    if (!this.#disposed) {
      void this.#run()
    }
  }

  isStale(): boolean {
    return this.#disposed
  }

  retryOnWake(): void {
    this.#disposers.push(
      this.#activity.subscribeWake(() => {
        this.schedule()
      }),
    )
  }

  onDispose(teardown: () => void): void {
    if (this.#disposed) {
      teardown()
      return
    }
    this.#disposers.push(teardown)
  }

  dispose(): void {
    this.#disposed = true
    for (const teardown of this.#disposers.splice(0)) {
      teardown()
    }
  }

  async #run(): Promise<void> {
    if (this.#running) {
      this.#queued = true
      return
    }
    this.#running = true
    try {
      do {
        this.#queued = false
        if ((await this.#options.pass(() => this.#disposed)) === 'stop') {
          break // keep any queued follow-up for the next external trigger
        }
      } while (this.#queued && !this.#disposed)
    } finally {
      this.#running = false
      this.#options.onSettled?.()
    }
  }
}

class BackgroundReconcilerFactoryImpl implements BackgroundReconcilerFactory {
  readonly #deps: BackgroundReconcilerFactoryDeps

  constructor(deps: BackgroundReconcilerFactoryDeps) {
    this.#deps = deps
  }

  create(options: BackgroundReconcilerOptions): BackgroundReconciler {
    return new BackgroundReconcilerImpl(this.#deps.activity, options)
  }
}

export function createBackgroundReconcilerFactory(
  deps: BackgroundReconcilerFactoryDeps,
): BackgroundReconcilerFactory {
  return new BackgroundReconcilerFactoryImpl(deps)
}
