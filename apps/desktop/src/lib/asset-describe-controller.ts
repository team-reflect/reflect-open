import {
  hasBridge,
  isEligibleAssetPath,
  isNotePath,
  isSilentStop,
  parseNote,
  readNote,
  reconcileAssetDescriptions,
  reindexNotesReferencing,
  subscribeIndexApplied,
  type AiProvidersState,
  type ReconcileStop,
} from '@reflect/core'
import { createBackgroundReconciler } from '@/lib/background-reconciler'
import { providerFetch } from '@/lib/provider-fetch'
import { invalidateIndexQueries } from '@/lib/query-client'

/**
 * The asset-description lifecycle for one graph session (Plan 20). Built on
 * {@link createBackgroundReconciler} (shared with capture and transcription):
 * the single-flight loop, focus/online retries, and teardown live there; this
 * supplies the asset-specific pass and triggers.
 *
 * Triggers fire off `subscribeIndexApplied` — the indexer's POST-APPLY signal —
 * not the raw watcher stream, so the privacy gate always reads a settled index
 * and can't race a just-written private note's indexing. It describes **new**
 * eligible assets only — there is no launch backfill (the explicit Settings
 * action handles existing assets). Observed assets accumulate in a dirty set;
 * each pass reconciles it. A transient (auth/network) stop leaves the set intact
 * so the next trigger retries; a clean pass clears it. Re-describing an
 * unchanged asset is cheap — its managed description's hash matches, so no
 * provider call is made.
 */
export interface AssetDescribeController {
  /** Attach the triggers (index-applied, focus, online). No launch backfill. */
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
  let started = false
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
    // self-healing stops (network/config/stale) stay silent, and the Settings
    // backfill is the user-initiated path that surfaces progress and errors. An
    // index-not-ready (io) failure during startup is unexpected here, so it is
    // logged (deduped) for diagnosis only.
    if (isSilentStop(stopped) || loggedStop === stopped.message) {
      return
    }
    loggedStop = stopped.message
    console.warn(`asset description stopped (${stopped.reason}): ${stopped.message}`)
  }

  /**
   * One reconcile pass over the dirty set, then fold any new descriptions into
   * the referencing notes' search rows so a query matching a description
   * surfaces the note (Plan 20 search integration). Returns `'stop'` on a
   * transient/config stop so the loop keeps the batch for the next trigger
   * instead of spinning.
   */
  const reconcile = async (isStale: () => boolean): Promise<void | 'stop'> => {
    if (!hasBridge() || dirty.size === 0) {
      return // browser dev (no graph to read assets from), or nothing pending
    }
    const batch = [...dirty]
    const outcome = await reconcileAssetDescriptions({
      providers: options.getProviders(),
      generation: options.generation,
      mode: 'incremental',
      changed: batch,
      fetchFn: providerFetch,
      isStale,
    })
    surfaceStop(outcome.stopped)
    if (isStale()) {
      return 'stop'
    }
    // Runs even on a stop — whatever was described is real. A re-index failure
    // must not crash the loop: the descriptions are written, so search catches
    // up on the note's next re-index or a rebuild. The re-index emits the
    // post-apply signal for the refreshed notes (the embedding sync re-embeds
    // them off it); our own index-applied trigger hears that emit too and
    // re-marks the notes' assets, which the next pass skips as up-to-date —
    // one cheap extra cycle, no loop (a clean pass writes nothing new).
    if (outcome.describedAssetPaths.length > 0) {
      try {
        await reindexNotesReferencing(outcome.describedAssetPaths, options.generation)
      } catch (cause) {
        console.warn('asset-description re-index failed:', cause)
      }
      // The re-index wrote search rows directly (not via the watcher → onApplied
      // path), so nothing invalidated the index-backed query caches
      // (staleTime: Infinity). Refresh them so ⌘K reflects the new descriptions.
      invalidateIndexQueries()
    }
    if (isStale()) {
      return 'stop'
    }
    if (outcome.stopped !== null) {
      return 'stop' // transient/config stop: keep the batch, wait for the next trigger
    }
    for (const path of batch) {
      dirty.delete(path)
    }
  }

  const loop = createBackgroundReconciler({ pass: reconcile })

  function markDirty(paths: readonly string[]): void {
    let added = false
    for (const path of paths) {
      if (!dirty.has(path)) {
        dirty.add(path)
        added = true
      }
    }
    if (added) {
      loop.schedule()
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
      if (loop.isStale()) {
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
    if (referenced.size > 0 && !loop.isStale()) {
      markDirty([...referenced])
    }
  }

  function start(): void {
    if (started || loop.isStale()) {
      return // idempotent: never register the DOM/watcher listeners twice
    }
    started = true
    loop.retryOnWake() // retry assets a prior pass left dirty after coming back online
    if (!hasBridge()) {
      return // browser dev: no indexer to follow
    }
    // Drive off the indexer's POST-APPLY signal, not the raw watcher stream: when
    // this fires the batch's note rows (privacy flags, `assets` projection) are
    // already in the index, so the privacy gate can't race a just-written private
    // note's indexing. Carries the full batch — asset-file upserts (a dropped
    // image) and note upserts (which may newly reference an asset).
    loop.onDispose(
      subscribeIndexApplied((changes, generation) => {
        if (generation !== options.generation) {
          return // a delayed emit from a graph we've switched away from
        }
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
      }),
    )
  }

  return { start, schedule: loop.schedule, dispose: loop.dispose }
}
