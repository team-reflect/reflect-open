import {
  audioMemoFromPath,
  hasBridge,
  isSilentStop,
  pickTranscriptionConfig,
  reconcileAudioMemos,
  subscribeFileChanges,
  type AiProvidersState,
  type ReconcileStop,
} from '@reflect/core'
import { createBackgroundReconciler } from '@/lib/background-reconciler'
import { startOperation } from '@/lib/operations'
import { providerFetch } from '@/lib/provider-fetch'

/**
 * The background-transcription lifecycle for one graph session. Built on
 * {@link createBackgroundReconciler} (shared with capture and asset
 * descriptions): the single-flight loop, focus/online retries, and teardown live
 * there; this adds the transcription pass, the config gate (no IO without a
 * transcription-capable model), and the `transcribing` flag the mic spinner
 * reads. The provider shrinks to create/start/dispose plus a `schedule()` after
 * its own captures.
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
  /** Read lazily so a settings toggle applies to the next reconcile pass. */
  getTranscriptionFormat: () => boolean
}

/** Build the reconciler for one graph session. `dispose()` is terminal. */
export function createTranscriptionReconciler(
  options: TranscriptionReconcilerOptions,
): TranscriptionReconciler {
  let transcribing = false
  const listeners = new Set<() => void>()
  /** Last surfaced stop message — focus/online retries must not re-toast it. */
  let surfacedStop: string | null = null

  function setTranscribing(next: boolean): void {
    if (transcribing === next) {
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
    // Expected, self-healing stops (network/config/stale) stay silent: offline
    // retries on the next trigger, and a missing provider/key already disables
    // the mic with the reason as its tooltip.
    if (isSilentStop(stopped) || surfacedStop === stopped.message) {
      return
    }
    surfacedStop = stopped.message
    startOperation('Transcribing audio memo').fail(stopped.message)
  }

  /** One pass: transcribe pending memos, gated behind a transcription-capable model. */
  const reconcile = async (isStale: () => boolean): Promise<void> => {
    // Gate before any IO: without a transcription-capable model every pass
    // would list the graph just to stop on `config`.
    if (pickTranscriptionConfig(options.getProviders()) === null) {
      return
    }
    const outcome = await reconcileAudioMemos({
      providers: options.getProviders(),
      generation: options.generation,
      formatTranscript: options.getTranscriptionFormat(),
      fetchFn: providerFetch,
      isStale,
      onPending: (count) => setTranscribing(count > 0),
    })
    surfaceStop(outcome.stopped)
  }

  const loop = createBackgroundReconciler({
    pass: reconcile,
    onSettled: () => setTranscribing(false),
  })

  function start(): void {
    if (loop.isStale()) {
      return
    }
    loop.schedule() // the launch pass: memos left pending by earlier sessions
    loop.retryOnWake() // the network's natural retry signals (focus/online)
    loop.onDispose(() => listeners.clear())
    if (!hasBridge()) {
      return // browser dev: no watcher to follow, no native foreground
    }
    // Foregrounding on iOS doesn't reliably fire `focus`/`online` on the
    // webview — `visibilitychange` → visible does. A memo captured (or its
    // transcription failed offline) while backgrounded gets its retry when
    // the app comes back. Bridge-gated, so desktop keeps focus/online only.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        loop.schedule()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    loop.onDispose(() => document.removeEventListener('visibilitychange', onVisible))
    void subscribeFileChanges((changes) => {
      const hasNewRecording = changes.some(
        (change) => change.kind === 'upsert' && audioMemoFromPath(change.path) !== null,
      )
      if (hasNewRecording) {
        loop.schedule()
      }
    })
      .then((stop) => loop.onDispose(stop)) // onDispose tears down now if we already disposed
      .catch((cause: unknown) => {
        // Degrades to the other triggers (focus/online/capture); surfaced
        // for diagnosis rather than left as an unhandled rejection.
        console.error('transcription file-change subscription failed:', cause)
      })
  }

  return {
    start,
    schedule: loop.schedule,
    getTranscribing: () => transcribing,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose: loop.dispose,
  }
}
