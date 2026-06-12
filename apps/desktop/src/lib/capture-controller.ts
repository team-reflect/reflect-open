import {
  drainCaptureInbox,
  hasBridge,
  isCaptureSpoolPath,
  reconcileCaptureEnrichment,
  subscribeFileChanges,
  type AiProvidersState,
  type ReconcileStop,
  type Unlisten,
} from '@reflect/core'
import { startOperation } from '@/lib/operations'
import { providerFetch } from '@/lib/provider-fetch'

/**
 * The link-capture lifecycle for one graph session — the same shape as
 * `createTranscriptionReconciler`, for the same reason: the trigger plumbing
 * (launch pass, watcher events, focus/online retries) breeds bugs inside a
 * React effect seam, so it lives in one object with one `dispose()`.
 *
 * Every pass runs the two capture phases in order: **drain** the spool inbox
 * (the durable raw save — works without any AI configured), then **enrich**
 * pending captures (meta scrape + BYOK description). The launch pass is the
 * headline behavior: captures spooled while the app was closed land the
 * moment a graph opens.
 */
export interface CaptureController {
  /** Attach the triggers (watcher, focus, online) and run the launch pass. */
  start(): void
  /** Request a pass; coalesces while one runs (at most one follow-up). */
  schedule(): void
  /** Tear down triggers and abort an in-flight pass at its next gate. */
  dispose(): void
}

export interface CaptureControllerOptions {
  /** The open graph's generation — every pass's reads and writes pin to it. */
  generation: number
  /**
   * The configured-providers state, read at the start of every pass — a key
   * added in Settings mid-session must be seen by the very next pass.
   */
  getProviders: () => AiProvidersState
}

/** Build the controller for one graph session. `dispose()` is terminal. */
export function createCaptureController(options: CaptureControllerOptions): CaptureController {
  let disposed = false
  let running = false
  /** A trigger landed mid-pass; run exactly one follow-up after it. */
  let queued = false
  let unlisten: Unlisten | null = null
  const domDisposers: Array<() => void> = []
  /** Last surfaced stop message — retries must not re-toast it. */
  let surfacedStop: string | null = null

  function surfaceStop(label: string, stopped: ReconcileStop | null): void {
    if (stopped === null) {
      surfacedStop = null
      return
    }
    // Self-healing stops stay silent: offline retries on the next trigger,
    // config means no provider/key (enrichment waits; the raw save is done),
    // stale is a graph switch tearing the pass down.
    if (stopped.reason === 'network' || stopped.reason === 'config' || stopped.reason === 'stale') {
      return
    }
    if (surfacedStop === stopped.message) {
      return
    }
    surfacedStop = stopped.message
    startOperation(label).fail(stopped.message)
  }

  async function run(): Promise<void> {
    if (running) {
      queued = true
      return
    }
    if (!hasBridge()) {
      return // browser dev: no inbox commands to drain against
    }
    running = true
    try {
      do {
        queued = false
        const drained = await drainCaptureInbox({
          generation: options.generation,
          isStale: () => disposed,
        })
        surfaceStop('Saving link capture', drained.stopped)
        if (disposed) {
          return
        }
        const enriched = await reconcileCaptureEnrichment({
          providers: options.getProviders(),
          generation: options.generation,
          fetchFn: providerFetch,
          isStale: () => disposed,
        })
        surfaceStop('Enriching link capture', enriched.stopped)
      } while (queued && !disposed)
    } finally {
      running = false
    }
  }

  function schedule(): void {
    if (!disposed) {
      void run()
    }
  }

  function start(): void {
    if (disposed) {
      return
    }
    schedule() // the launch pass: captures spooled while the app was closed
    const onWake = (): void => {
      schedule() // the network's natural retry signals (enrichment)
    }
    window.addEventListener('focus', onWake)
    window.addEventListener('online', onWake)
    domDisposers.push(
      () => window.removeEventListener('focus', onWake),
      () => window.removeEventListener('online', onWake),
    )
    if (!hasBridge()) {
      return // browser dev: no watcher to follow
    }
    void subscribeFileChanges((changes) => {
      const hasNewCapture = changes.some(
        (change) => change.kind === 'upsert' && isCaptureSpoolPath(change.path),
      )
      if (hasNewCapture) {
        schedule()
      }
    })
      .then((stop) => {
        if (disposed) {
          stop() // teardown won the race against the subscribe
        } else {
          unlisten = stop
        }
      })
      .catch((cause: unknown) => {
        // Degrades to the launch/focus/online triggers; surfaced for
        // diagnosis rather than left as an unhandled rejection.
        console.error('capture file-change subscription failed:', cause)
      })
  }

  return {
    start,
    schedule,
    dispose: () => {
      disposed = true
      unlisten?.()
      unlisten = null
      for (const stop of domDisposers.splice(0)) {
        stop()
      }
    },
  }
}
