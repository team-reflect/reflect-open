import {
  audioMemoFromPath,
  hasBridge,
  pickTranscriptionConfig,
  reconcileAudioMemos,
  subscribeFileChanges,
  type AiProvidersState,
  type ReconcileStop,
  type Unlisten,
} from '@reflect/core'
import { startOperation } from '@/lib/operations'
import { providerFetch } from '@/lib/provider-fetch'

/**
 * The background-transcription lifecycle for one graph session, extracted
 * from React for the same reason as `createBackupController`: loop guards,
 * teardown, and trigger plumbing breed bugs in the provider's effect seam.
 * Here the lifecycle is one object with one `dispose()`, and the provider
 * shrinks to create/start/dispose plus a `schedule()` after its own captures.
 *
 * Owns: the single-flight pass loop (a trigger landing mid-pass queues at
 * most one follow-up), the config gate (no IO without a transcription-capable
 * model), the dispose-driven stale gate every pass checks between memos, the
 * `transcribing` flag the mic spinner reads, deduped stop surfacing, the
 * window focus/online retry listeners, and the file-change subscription that
 * picks up recordings the watcher reports — ours just captured, or one a
 * sync merge pulled from another device.
 */
export interface TranscriptionReconciler {
  /** Attach the triggers (focus, online, file changes) and run the launch pass. */
  start(): void
  /** Request a pass; coalesces while one runs (at most one follow-up). */
  schedule(): void
  /** True while a pass has memos to transcribe — drives the mic spinner. */
  getTranscribing(): boolean
  /** Subscribe to `transcribing` changes; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
  /** Tear down triggers and abort an in-flight pass at its next gate. */
  dispose(): void
}

export interface TranscriptionReconcilerOptions {
  /** The open graph's generation — every pass's reads and writes pin to it. */
  generation: number
  /**
   * The configured-providers state, read at the start of every pass rather than
   * captured once — a key the user adds in Settings mid-session must be seen
   * by the very next pass.
   */
  getProviders: () => AiProvidersState
}

/** Build the reconciler for one graph session. `dispose()` is terminal. */
export function createTranscriptionReconciler(
  options: TranscriptionReconcilerOptions,
): TranscriptionReconciler {
  let disposed = false
  let running = false
  /** A trigger landed mid-pass; run exactly one follow-up after it. */
  let queued = false
  let transcribing = false
  const listeners = new Set<() => void>()
  let unlisten: Unlisten | null = null
  const domDisposers: Array<() => void> = []
  /** Last surfaced stop message — focus/online retries must not re-toast it. */
  let surfacedStop: string | null = null

  function setTranscribing(next: boolean): void {
    if (disposed || transcribing === next) {
      return
    }
    transcribing = next
    for (const listener of listeners) {
      listener()
    }
  }

  function surfaceStop(stopped: ReconcileStop | null): void {
    if (stopped === null) {
      surfacedStop = null
      return
    }
    // Expected, self-healing stops stay silent: offline retries on the next
    // trigger, and a missing provider/key already disables the mic with the
    // reason as its tooltip.
    if (stopped.reason === 'network' || stopped.reason === 'config' || stopped.reason === 'stale') {
      return
    }
    if (surfacedStop === stopped.message) {
      return
    }
    surfacedStop = stopped.message
    startOperation('Transcribing audio memo').fail(stopped.message)
  }

  async function run(): Promise<void> {
    if (running) {
      queued = true
      return
    }
    // Gate before any IO: without a transcription-capable model every pass
    // would list the graph just to stop on `config`.
    if (pickTranscriptionConfig(options.getProviders()) === null) {
      return
    }
    running = true
    try {
      do {
        queued = false
        const outcome = await reconcileAudioMemos({
          providers: options.getProviders(),
          generation: options.generation,
          fetchFn: providerFetch,
          isStale: () => disposed,
          onPending: (count) => setTranscribing(count > 0),
        })
        surfaceStop(outcome.stopped)
      } while (queued && !disposed)
    } finally {
      running = false
      setTranscribing(false)
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
    schedule() // the launch pass: memos left pending by earlier sessions
    const onWake = (): void => {
      schedule() // the network's natural retry signals
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
      const hasNewRecording = changes.some(
        (change) => change.kind === 'upsert' && audioMemoFromPath(change.path) !== null,
      )
      if (hasNewRecording) {
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
        // Degrades to the other triggers (focus/online/capture); surfaced
        // for diagnosis rather than left as an unhandled rejection.
        console.error('transcription file-change subscription failed:', cause)
      })
  }

  return {
    start,
    schedule,
    getTranscribing: () => transcribing,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose: () => {
      disposed = true
      unlisten?.()
      unlisten = null
      for (const stop of domDisposers.splice(0)) {
        stop()
      }
      listeners.clear()
    },
  }
}
