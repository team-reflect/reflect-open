import {
  openIndex,
  reconcileIndex,
  subscribeIndexChanges,
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
   * Open + migrate the index for the now-active graph and return its generation.
   * Best-effort: returns `null` (and reports via `onError`) if the open fails, so
   * a broken index never blocks editing.
   */
  open: () => Promise<number | null>
  /**
   * Background-sync the open index at `generation`: reconcile the whole graph,
   * then subscribe to live `index:changed` events, then start the Rust watcher —
   * sequenced so the passes never write concurrently. `isStale` is checked
   * between steps and bails when a newer open supersedes this one. When
   * `generation` is `null` (open failed / no index), any previous watcher is
   * stopped instead. Call only after the graph row is committed.
   */
  sync: (generation: number | null, isStale: () => boolean) => void
}

/** Stage of the index lifecycle that failed, for `onError` reporting. */
export type GraphIndexStage = 'open' | 'sync'

export interface GraphIndexOptions {
  /** Called when a stage fails. The lifecycle itself never throws. */
  onError?: (stage: GraphIndexStage, error: unknown) => void
}

/**
 * Create a {@link GraphIndex}. Holds the in-flight sync's `AbortController`,
 * settlement promise, and the live-subscription unlisten internally; the caller
 * keeps one instance (e.g. in a ref) across graph switches.
 */
export function createGraphIndex(options: GraphIndexOptions = {}): GraphIndex {
  const { onError } = options
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

  async function open(): Promise<number | null> {
    try {
      return await openIndex()
    } catch (error) {
      onError?.('open', error)
      return null
    }
  }

  function sync(generation: number | null, isStale: () => boolean): void {
    // Abort any in-flight pass so calling sync() twice without an intervening
    // stop() can't leave an orphaned, un-abortable reconcile running.
    abort?.abort()
    // Tear down the previous graph's live subscription unconditionally, so a
    // failed/absent open can't leave it bound to a different graph.
    live.unlisten?.()
    live.unlisten = null

    if (generation === null) {
      // No index for this graph — stop any watcher left from the previous one.
      void watchStop().catch(() => {})
      return
    }

    const controller = new AbortController()
    abort = controller
    done = (async () => {
      // A subscription created but not yet adopted (superseded mid-flight, or a
      // later step threw) is torn down in `finally` so listeners can't leak.
      let pending: (() => void) | null = null
      try {
        await reconcileIndex({ generation, signal: controller.signal })
        if (isStale()) {
          return
        }
        pending = await subscribeIndexChanges(generation)
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
      } catch (error) {
        onError?.('sync', error)
      } finally {
        pending?.()
      }
    })()
  }

  return { stop, open, sync }
}
