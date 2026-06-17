import {
  drainCaptureInbox,
  hasBridge,
  isCaptureSpoolPath,
  isSilentStop,
  reconcileCaptureEnrichment,
  subscribeFileChanges,
  type AiProvidersState,
  type ReconcileStop,
} from '@reflect/core'
import { createBackgroundReconciler } from '@/lib/background-reconciler'
import { startOperation } from '@/lib/operations'
import { providerFetch } from '@/lib/provider-fetch'

/**
 * The link-capture lifecycle for one graph session. Built on
 * {@link createBackgroundReconciler} (shared with transcription and asset
 * descriptions): the single-flight loop, focus/online retries, and teardown live
 * there; this supplies the capture-specific pass and triggers.
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
  /** Last surfaced stop message — retries must not re-toast it. */
  let surfacedStop: string | null = null

  function surfaceStop(label: string, stopped: ReconcileStop | null): void {
    if (stopped === null) {
      surfacedStop = null
      return
    }
    // Self-healing stops (network/config/stale) stay silent: offline retries on
    // the next trigger, config means no provider/key (enrichment waits; the raw
    // save is done), stale is a graph switch tearing the pass down.
    if (isSilentStop(stopped) || surfacedStop === stopped.message) {
      return
    }
    surfacedStop = stopped.message
    startOperation(label).fail(stopped.message)
  }

  /** One pass: drain the spool inbox (no AI needed), then enrich pending captures. */
  const reconcile = async (isStale: () => boolean): Promise<void> => {
    if (!hasBridge()) {
      return // browser dev: no inbox commands to drain against
    }
    const drained = await drainCaptureInbox({ generation: options.generation, isStale })
    surfaceStop('Saving link capture', drained.stopped)
    if (isStale()) {
      return
    }
    const enriched = await reconcileCaptureEnrichment({
      providers: options.getProviders(),
      generation: options.generation,
      fetchFn: providerFetch,
      isStale,
    })
    surfaceStop('Enriching link capture', enriched.stopped)
  }

  const loop = createBackgroundReconciler({ pass: reconcile })

  function start(): void {
    if (loop.isStale()) {
      return
    }
    loop.schedule() // the launch pass: captures spooled while the app was closed
    loop.retryOnWake() // the network's natural retry signals (enrichment)
    if (!hasBridge()) {
      return // browser dev: no watcher to follow
    }
    void subscribeFileChanges((changes) => {
      const hasNewCapture = changes.some(
        (change) => change.kind === 'upsert' && isCaptureSpoolPath(change.path),
      )
      if (hasNewCapture) {
        loop.schedule()
      }
    })
      .then((stop) => loop.onDispose(stop)) // onDispose tears down now if we already disposed
      .catch((cause: unknown) => {
        // Degrades to the launch/focus/online triggers; surfaced for
        // diagnosis rather than left as an unhandled rejection.
        console.error('capture file-change subscription failed:', cause)
      })
  }

  return { start, schedule: loop.schedule, dispose: loop.dispose }
}
