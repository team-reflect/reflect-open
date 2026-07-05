import {
  openIndex,
  subscribeIndexChanges,
  syncIndex,
  watchStart,
  watchStop,
} from '@reflect/core'

/**
 * The active graph's index lifecycle, factored out of `GraphProvider` so the
 * open → reconcile → subscribe → watch sequence is testable on its own and the
 * provider is left to own graph state and the open-ordering guards.
 *
 * Usage on a graph switch (the caller still gates on its own open token):
 *
 * ```ts
 * await index.stop()                       // halt the previous graph's sync pass
 * const generation = await index.open()    // open the new graph's index
 * if (stale) return
 * index.sync(generation, () => stale)      // background reconcile + live watch
 * await index.close()                      // no graph/index remains active
 * ```
 *
 * Every write carries the index `generation` returned by {@link GraphIndex.open};
 * Rust no-ops a write whose generation is stale, so even a pass that races a
 * connection swap can't corrupt the newly-opened index.
 */
export interface GraphIndex {
  /**
   * Abort the in-flight reconcile (if any) and wait for the sync pass to fully
   * settle, so a stale pass can't keep running into the next graph's open.
   */
  stop: () => Promise<void>
  /**
   * Wait for the current sync pass (if any) to finish, without aborting it.
   * The refresh coalescer serializes reruns off this.
   */
  settled: () => Promise<void>
  /**
   * Fully close the active index lifecycle: abort any reconcile, drop the live
   * subscription, stop the file watcher, and report idle progress.
   */
  close: () => Promise<void>
  /**
   * Open + migrate the index for the now-active graph and return its generation.
   * Best-effort: returns `null` (and reports via `onError`) if the open fails, so
   * a broken index never blocks editing.
   */
  open: () => Promise<number | null>
  /**
   * Background-sync the open index at `generation`: sync the whole graph
   * (hash reconcile, or a full rebuild when the stored projection version is
   * stale — `syncIndex` decides), then subscribe to live `index:changed`
   * events, then start the Rust watcher — sequenced so the passes never write
   * concurrently. `isStale` is checked between steps and bails when a newer
   * open supersedes this one. Call only after the graph row is committed.
   */
  sync: (generation: number, isStale: () => boolean) => void
  /**
   * Re-run the sync pass, coalescing concurrent triggers (resume, poll-end,
   * watch-failed can fire together): while one refresh is settling, further
   * calls fold into a single queued rerun instead of stacking abort/restart
   * cycles — on a large graph each stacked cycle was a full pass.
   */
  refresh: (generation: number, isStale: () => boolean) => void
}

/** Stage of the index lifecycle that failed, for `onError` reporting. */
export type GraphIndexStage = 'open' | 'sync'

/** Live progress of the background sync, for UI surfacing (Plan 06b). */
export type GraphIndexProgress = 'reconciling' | 'live' | 'idle'

export interface GraphIndexOptions {
  /** Called when a stage fails. The lifecycle itself never throws. */
  onError?: (stage: GraphIndexStage, error: unknown) => void
  /**
   * Called as the sync pass progresses. Bailed (superseded) passes emit
   * nothing further — the newer open's pass owns the indicator.
   */
  onProgress?: (progress: GraphIndexProgress) => void
  /**
   * Called after index rows actually changed — once when the initial reconcile
   * commits, then per applied watcher batch. Drives query-cache invalidation
   * (Plan 07): firing on raw file events instead would refetch stale rows.
   */
  onApplied?: () => void
  /**
   * Called when id-based healing relocates a note's rows (Plan 17): an
   * external rename observed by the reconcile or a watcher batch. The app
   * carries live sessions and rewrites routes off this, exactly as for an
   * in-app rename.
   */
  onMoved?: (from: string, to: string) => void
  /**
   * Called as a sync pass advances through the file listing (`done`,
   * `total`, `worked`) — the substrate for a "Preparing your notes… 400 of
   * 3,000" surface during a first index. `worked` counts files the pass has
   * actually read (vs skipped read-free); the UI gates on it so a routine
   * skip-everything pass never surfaces. Superseded passes stop reporting.
   */
  onFileProgress?: (done: number, total: number, worked: number) => void
}

/**
 * Create a {@link GraphIndex}. Holds the in-flight sync's `AbortController`,
 * settlement promise, and the live-subscription unlisten internally; the caller
 * keeps one instance (e.g. in a ref) across graph switches.
 */
export function createGraphIndex(options: GraphIndexOptions = {}): GraphIndex {
  const { onError, onProgress, onApplied, onMoved, onFileProgress } = options
  let abort: AbortController | null = null
  let done: Promise<void> = Promise.resolve()
  // Boxed so the async sync pass can read/replace the active subscription without
  // TS narrowing the closure-captured binding (the same reason the provider
  // previously held this in a ref's `.current`).
  const live: { unlisten: (() => void) | null } = { unlisten: null }

  async function stop(): Promise<void> {
    abort?.abort()
    await done.catch(() => {})
  }

  async function settled(): Promise<void> {
    await done.catch(() => {})
  }

  async function close(): Promise<void> {
    await stop()
    live.unlisten?.()
    live.unlisten = null
    onProgress?.('idle')
    await watchStop().catch(() => {})
  }

  async function open(): Promise<number | null> {
    try {
      return await openIndex()
    } catch (error) {
      onError?.('open', error)
      return null
    }
  }

  function sync(generation: number, isStale: () => boolean): void {
    // Tear down the previous graph's live subscription unconditionally, so a
    // failed/absent open can't leave it bound to a different graph.
    live.unlisten?.()
    live.unlisten = null

    onProgress?.('reconciling')
    const controller = new AbortController()
    abort = controller
    done = (async () => {
      // A subscription created but not yet adopted (superseded mid-flight, or a
      // later step threw) is torn down in `finally` so listeners can't leak.
      let pending: (() => void) | null = null
      try {
        await syncIndex({
          generation,
          signal: controller.signal,
          ...(onMoved !== undefined ? { onMoved } : {}),
          ...(onFileProgress !== undefined
            ? {
                onFileProgress: (progressDone: number, total: number, worked: number) => {
                  if (!isStale()) {
                    onFileProgress(progressDone, total, worked)
                  }
                },
              }
            : {}),
        })
        if (isStale()) {
          return
        }
        onApplied?.()
        pending = await subscribeIndexChanges(generation, onApplied, onMoved)
        if (isStale()) {
          return
        }
        await watchStart()
        if (isStale()) {
          return
        }
        live.unlisten?.()
        live.unlisten = pending
        pending = null // ownership transferred
        onProgress?.('live')
      } catch (error) {
        onError?.('sync', error)
        if (!isStale()) {
          onProgress?.('idle')
        }
      } finally {
        pending?.()
      }
    })()
  }

  let refreshRunning = false
  let refreshQueued = false

  function refresh(generation: number, isStale: () => boolean): void {
    if (refreshRunning) {
      refreshQueued = true
      return
    }
    refreshRunning = true
    void (async () => {
      try {
        do {
          refreshQueued = false
          // Settle (abort) any in-flight pass first so two passes never write
          // concurrently, then bail if a newer open superseded this graph.
          await stop()
          if (isStale()) {
            return
          }
          sync(generation, isStale)
          await settled()
        } while (refreshQueued)
      } finally {
        refreshRunning = false
      }
    })()
  }

  return { stop, settled, close, open, sync, refresh }
}
