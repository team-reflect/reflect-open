import {
  applyIndexChanges,
  emitFileChanges,
  icloudConflictsScan,
  icloudWatchStart,
  icloudWatchStop,
  isNotePath,
  subscribeFileChanges,
  subscribeIcloudConflicts,
  subscribeIcloudWatchFailed,
  subscribeOwnWrites,
  type FileChange,
  type GraphInfo,
} from '@reflect/core'
import { dirtyOpenPaths } from '@/editor/open-documents'
import { invalidateIndexQueries } from '@/lib/query-client'

/**
 * Whether a graph root lives under iCloud Drive: the app's container and the
 * user-visible iCloud Drive folder both sit under `…/Library/Mobile
 * Documents/` on macOS and iOS.
 */
export function isICloudRoot(root: string): boolean {
  return root.includes('/Mobile Documents/')
}

/** How long after a save a watcher event still counts as our own write. */
const OWN_WRITE_TTL_MS = 5_000
/** Debounce between a change signal and the sweep it triggers. */
const SCAN_DEBOUNCE_MS = 1_000
/**
 * Resume-trigger dedupe: one transition can fire `focus` and
 * `visibilitychange` together (the backup controller's window, same value).
 */
const RESUME_SCAN_DEDUPE_MS = 1_500

export interface IcloudControllerOptions {
  graph: GraphInfo
  /** The open index session; sweep results reindex under it. */
  indexGeneration: number | null
  /**
   * Emit `index:changed` from the metadata query's snapshot diffs — true on
   * mobile (the query is the only external-change source there), false on
   * desktop (the `notify` watcher already reports file events).
   */
  emitFileChangesFromWatch: boolean
}

export interface IcloudController {
  start: () => Promise<void>
  dispose: () => void
}

/**
 * The iCloud sync lifecycle for one (graph, index session) — the Plan 21
 * counterpart of the backup controller, and deliberately much smaller:
 * iCloud moves the files itself, so all that's left to own is *conflict*
 * handling and shadow-base bookkeeping.
 *
 * - Starts/stops the native metadata-query watch.
 * - Debounces `icloud:conflicts` signals and external file-change batches
 *   into conflict sweeps (`icloud_conflicts_scan`).
 * - Classifies external arrivals (not this device's own writes — tracked via
 *   the own-write echo — and not the sweep's own output) as clean ingests,
 *   which advance the notes' shadow merge bases.
 * - Fans a sweep's rewrites to every file-change subscriber and reindexes
 *   them directly, exactly like the backup controller's pull path.
 * - Sweeps again on resume/focus: the metadata query only covers the app's
 *   own container, so graphs the user placed in the general iCloud Drive
 *   folder get no conflict signal — and a conflict version can appear
 *   without the working file changing, which the `notify` watcher can't see
 *   either. The resume sweep is the backstop for both.
 *
 * Dirty open sessions are deferred (their paths ride `skipPaths`) as a
 * courtesy, not a safety net — even without it, a sweep write lands on disk
 * and the session's own external-change reconciliation parks it as a
 * conflict, the same as any external edit.
 */
export function createIcloudController(options: IcloudControllerOptions): IcloudController {
  const { graph, indexGeneration, emitFileChangesFromWatch } = options
  let disposed = false
  let baselinePending = true
  const disposers: Array<() => void> = []
  const ownWrites = new Map<string, number>()
  let pendingIngest = new Set<string>()
  let applyingSweepResult = false
  let scanTimer: ReturnType<typeof setTimeout> | null = null
  let scanRunning = false
  let scanQueued = false

  function scheduleScan(): void {
    if (disposed || scanTimer !== null) {
      return
    }
    scanTimer = setTimeout(() => {
      scanTimer = null
      void runScan()
    }, SCAN_DEBOUNCE_MS)
  }

  async function runScan(): Promise<void> {
    if (disposed) {
      return
    }
    if (scanRunning) {
      scanQueued = true
      return
    }
    scanRunning = true
    const ingested = [...pendingIngest]
    pendingIngest = new Set()
    const recordBaseline = baselinePending
    baselinePending = false
    try {
      const outcome = await icloudConflictsScan({
        generation: graph.generation,
        skipPaths: dirtyOpenPaths(),
        ingestedPaths: ingested,
        recordBaseline,
      })
      if (!disposed && outcome.changed.length > 0) {
        applySweepChanges(outcome.changed)
      }
    } catch (err) {
      // A failed sweep leaves versions unresolved; the next signal retries.
      console.error('iCloud conflict sweep failed:', err)
      for (const path of ingested) {
        pendingIngest.add(path) // don't lose the base advances
      }
      if (recordBaseline) {
        baselinePending = true // the adoption baseline must survive a failed first sweep
      }
    } finally {
      scanRunning = false
      if (scanQueued) {
        scanQueued = false
        scheduleScan()
      }
    }
  }

  /**
   * Fan sweep rewrites out to every file-change subscriber (open sessions
   * reconcile from these) *and* reindex them under the open index session,
   * exactly like the backup controller's pull path — the sweep must never
   * wait on the watcher to notice its own writes.
   */
  function applySweepChanges(changes: FileChange[]): void {
    // Sweep rewrites ARE this device's writes, but they don't route through
    // writeNote, so no own-write echo fires — and `applyingSweepResult`
    // below can't cover the *debounced* watcher echo that follows. Mark
    // them so that echo never classifies as an external base ingest. (The
    // Rust side independently refuses marker-bearing content as a base;
    // this also keeps clean-merge echoes from scheduling useless rescans.)
    const now = Date.now()
    for (const change of changes) {
      ownWrites.set(change.path, now)
    }
    applyingSweepResult = true
    try {
      emitFileChanges(changes)
    } finally {
      applyingSweepResult = false
    }
    const indexable = changes.filter((change) => isNotePath(change.path))
    if (indexGeneration !== null && indexable.length > 0) {
      void applyIndexChanges(indexable, indexGeneration).then(invalidateIndexQueries)
    }
  }

  function pruneOwnWrites(now: number): void {
    for (const [path, stamp] of ownWrites) {
      if (now - stamp > OWN_WRITE_TTL_MS) {
        ownWrites.delete(path)
      }
    }
  }

  async function start(): Promise<void> {
    if (disposed) {
      return
    }
    try {
      await icloudWatchStart(graph.root, emitFileChangesFromWatch)
    } catch (err) {
      console.error('iCloud watch failed to start:', err)
      // Sweeps still run off file-change batches; carry on.
    }
    disposers.push(subscribeOwnWrites((path) => {
      const now = Date.now()
      ownWrites.set(path, now)
      pruneOwnWrites(now)
    }))
    // Subscriptions are defensive like the watch above: a failed listen must
    // not reject start() (an unhandled rejection at the provider's call site)
    // or skip the initial sweep below — resume triggers and the baseline scan
    // keep conflict handling alive without them.
    try {
      disposers.push(
        await subscribeFileChanges((changes) => {
          if (disposed || applyingSweepResult) {
            return
          }
          const now = Date.now()
          pruneOwnWrites(now)
          for (const change of changes) {
            if (change.kind !== 'upsert' || !isNotePath(change.path)) {
              continue
            }
            if (ownWrites.has(change.path)) {
              continue // our own save landing — never advances the base
            }
            pendingIngest.add(change.path)
          }
          scheduleScan()
        }),
      )
      disposers.push(
        await subscribeIcloudConflicts(() => {
          if (!disposed) {
            scheduleScan()
          }
        }),
      )
      disposers.push(
        await subscribeIcloudWatchFailed(() => {
          if (disposed) {
            return
          }
          // The live watch never started (fire-and-forget install failed
          // after the command returned). Freshness now rides file-change
          // batches and the resume sweeps — say so loudly for debugging
          // stale-state reports, and sweep once right away.
          console.error('iCloud watch failed to start; relying on resume-triggered sweeps')
          scheduleScan()
        }),
      )
    } catch (err) {
      console.error('iCloud change subscriptions failed to start:', err)
    }
    disposers.push(...attachResumeListeners(scheduleScan))
    // The adoption baseline + any conflicts that accrued while closed.
    scheduleScan()
  }

  function dispose(): void {
    disposed = true
    if (scanTimer !== null) {
      clearTimeout(scanTimer)
      scanTimer = null
    }
    for (const disposeOne of disposers.splice(0)) {
      disposeOne()
    }
    void icloudWatchStop().catch(() => {
      // Shutdown/switch race — the next start replaces the watch anyway.
    })
  }

  return { start, dispose }
}

/**
 * Wire the resume triggers (same shape as the backup controller's): `focus`
 * for a desktop refocus, visibility → visible for mobile resume and desktop
 * unminimize. One transition can fire both events, so `onResume` calls are
 * deduped within {@link RESUME_SCAN_DEDUPE_MS}. Returns the listeners'
 * disposers.
 */
function attachResumeListeners(onResume: () => void): Array<() => void> {
  let lastResumeAt = 0
  const resume = (): void => {
    const now = Date.now()
    if (now - lastResumeAt < RESUME_SCAN_DEDUPE_MS) {
      return
    }
    lastResumeAt = now
    onResume()
  }
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      resume()
    }
  }
  window.addEventListener('focus', resume)
  document.addEventListener('visibilitychange', onVisibilityChange)
  return [
    () => window.removeEventListener('focus', resume),
    () => document.removeEventListener('visibilitychange', onVisibilityChange),
  ]
}
