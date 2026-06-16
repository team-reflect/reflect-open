import {
  hasBridge,
  isEligibleAssetPath,
  isNotePath,
  parseNote,
  readNote,
  reconcileAssetDescriptions,
  reindexNotesReferencing,
  subscribeFileChanges,
  type AiProvidersState,
  type ReconcileStop,
  type Unlisten,
} from '@reflect/core'
import { providerFetch } from '@/lib/provider-fetch'

/**
 * The asset-description lifecycle for one graph session (Plan 20). Mirrors
 * `createCaptureController`: the trigger plumbing (watcher events, focus/online
 * retries) lives in one object with one `dispose()`.
 *
 * It describes **new** eligible assets only — there is no launch backfill (the
 * explicit Settings action handles existing assets). Eligible asset upserts
 * reported by the watcher accumulate in a dirty set; each pass reconciles that
 * set. A transient (auth/network) stop leaves the set intact so the next
 * trigger retries; a clean pass clears it. Re-describing an unchanged asset is
 * cheap — its managed description's hash matches, so no provider call is made.
 */
export interface AssetDescribeController {
  /** Attach the triggers (watcher, focus, online). No launch backfill. */
  start(): void
  /** Request a pass; coalesces while one runs (at most one follow-up). */
  schedule(): void
  /** Tear down triggers and abort an in-flight pass at its next gate. */
  dispose(): void
}

export interface AssetDescribeControllerOptions {
  /** The open graph's generation — every pass's reads and writes pin to it. */
  generation: number
  /**
   * The configured-providers state, read at the start of every pass — a key
   * added in Settings mid-session must be seen by the very next pass.
   */
  getProviders: () => AiProvidersState
}

/** Build the controller for one graph session. `dispose()` is terminal. */
export function createAssetDescribeController(
  options: AssetDescribeControllerOptions,
): AssetDescribeController {
  let disposed = false
  let running = false
  /** A trigger landed mid-pass; run exactly one follow-up after it. */
  let queued = false
  let unlisten: Unlisten | null = null
  const domDisposers: Array<() => void> = []
  /** Eligible assets observed changed and not yet successfully reconciled. */
  const dirty = new Set<string>()
  /** Last logged stop message — retries must not re-log it. */
  let loggedStop: string | null = null

  function surfaceStop(stopped: ReconcileStop | null): void {
    if (stopped === null) {
      loggedStop = null
      return
    }
    // Automatic description is background, best-effort work, so it never toasts:
    // network retries on the next trigger, config means no provider/key yet (the
    // asset waits), stale is a graph switch, and an index-not-ready (io) failure
    // during startup is transient too. The Settings backfill is the user-initiated
    // path that surfaces progress and errors. Log unexpected stops (deduped) for
    // diagnosis only.
    if (stopped.reason === 'network' || stopped.reason === 'config' || stopped.reason === 'stale') {
      return
    }
    if (loggedStop === stopped.message) {
      return
    }
    loggedStop = stopped.message
    console.warn(`asset description stopped (${stopped.reason}): ${stopped.message}`)
  }

  async function run(): Promise<void> {
    if (running) {
      queued = true
      return
    }
    if (!hasBridge()) {
      return // browser dev: no graph to read assets from
    }
    running = true
    try {
      do {
        queued = false
        if (dirty.size === 0) {
          break
        }
        const batch = [...dirty]
        const outcome = await reconcileAssetDescriptions({
          providers: options.getProviders(),
          generation: options.generation,
          mode: 'incremental',
          changed: batch,
          fetchFn: providerFetch,
          isStale: () => disposed,
        })
        surfaceStop(outcome.stopped)
        if (disposed) {
          return
        }
        // Fold the new descriptions into the referencing notes' search rows so
        // a query matching a description surfaces the note (Plan 20 search
        // integration). Runs even on a stop — whatever was described is real.
        // A re-index failure must not crash the loop: the descriptions are
        // written, so search catches up on the note's next re-index or a rebuild.
        if (outcome.describedAssetPaths.length > 0) {
          try {
            await reindexNotesReferencing(outcome.describedAssetPaths, options.generation)
          } catch (cause) {
            console.warn('asset-description re-index failed:', cause)
          }
        }
        if (disposed) {
          return
        }
        if (outcome.stopped === null) {
          for (const path of batch) {
            dirty.delete(path)
          }
        } else {
          break // transient/config stop: keep the batch, wait for the next trigger
        }
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

  function markDirty(paths: readonly string[]): void {
    let added = false
    for (const path of paths) {
      if (!dirty.has(path)) {
        dirty.add(path)
        added = true
      }
    }
    if (added) {
      schedule()
    }
  }

  /**
   * A note changed — re-evaluate the eligible assets it references. This is the
   * "relevant note changes" trigger: an asset already on disk that a note edit
   * newly makes public (referenced by a non-private note) gets described, even
   * though the asset file itself did not change. Already-described assets fall
   * through the reconcile's hash check cheaply, so re-marking is harmless.
   */
  async function markAssetsFromNotes(notePaths: readonly string[]): Promise<void> {
    const referenced = new Set<string>()
    for (const notePath of notePaths) {
      if (disposed) {
        return
      }
      let source: string
      try {
        source = await readNote(notePath, options.generation)
      } catch {
        continue // deleted/unreadable since the change — nothing to re-evaluate
      }
      for (const asset of parseNote({ path: notePath, source }).assets) {
        if (isEligibleAssetPath(asset.path)) {
          referenced.add(asset.path)
        }
      }
    }
    if (referenced.size > 0 && !disposed) {
      markDirty([...referenced])
    }
  }

  function start(): void {
    if (disposed) {
      return
    }
    const onWake = (): void => {
      schedule() // retry any assets a prior pass left dirty after coming back online
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
      const newAssets: string[] = []
      const changedNotes: string[] = []
      for (const change of changes) {
        if (change.kind !== 'upsert') {
          continue
        }
        if (isEligibleAssetPath(change.path)) {
          newAssets.push(change.path)
        } else if (isNotePath(change.path)) {
          changedNotes.push(change.path)
        }
      }
      if (newAssets.length > 0) {
        markDirty(newAssets)
      }
      if (changedNotes.length > 0) {
        void markAssetsFromNotes(changedNotes)
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
        // Degrades to the focus/online triggers; surfaced for diagnosis rather
        // than left as an unhandled rejection.
        console.error('asset-description file-change subscription failed:', cause)
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
