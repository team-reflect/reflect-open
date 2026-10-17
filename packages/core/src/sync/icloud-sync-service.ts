import type { MaybePromise } from '@reflect/utils'
import type { ClockService, TimerHandle } from '../ports/clock-service.ts'
import type { ActivityPort } from '../ports/activity-port.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import type { OpenDocumentsService } from '../documents/open-documents-service.ts'
import { isNotePath } from '../graph/paths.ts'
import type { FileChange, FileChangeService } from '../indexing/file-change-service.ts'
import type { IndexLifecycleService } from '../indexing/index-lifecycle-service.ts'
import type { ICloudNativeService, IcloudSweepScope } from '../ipc/icloud-native-service.ts'
import type { Unlisten } from '../unlisten.ts'
import { describeConflictCopies } from './conflict-copies.ts'

/**
 * Whether a graph root lives under iCloud Drive: the app's container and the
 * user-visible iCloud Drive folder both sit under `…/Library/Mobile
 * Documents/` on macOS and iOS.
 */
export function isICloudRoot(root: string): boolean {
  return root.includes('/Mobile Documents/')
}

/**
 * Debounce between a change signal and the sweep it triggers.
 */
const SCAN_DEBOUNCE_MS = 1_000
/**
 * Debounce for scans triggered purely by external file arrivals. During an
 * initial iCloud sync, arrivals stream in continuously and every sweep walks
 * the whole graph (an `NSFileVersion` query per file); a wider window batches
 * a download burst into far fewer sweeps. Conflict signals and resumes keep
 * the shorter window — and an earlier-due request always wins.
 */
const INGEST_SCAN_DEBOUNCE_MS = 5_000
/**
 * Minimum gap between the end of one sweep and the start of the next
 * *arrival-triggered* one. The debounce alone still ran a full-graph sweep
 * every ~5s for the length of an initial download — each one a tree walk
 * plus a per-file version query, contending with the downloads themselves.
 * Base advances are not latency-sensitive (the ingest set just accumulates),
 * so a bulk sync gets a handful of sweeps instead of dozens. Conflict
 * signals and resumes are unaffected.
 */
const INGEST_SCAN_MIN_SPACING_MS = 30_000

/**
 * The (graph, index session) pair one {@link ICloudSyncService} serves.
 */
export interface ICloudSyncServiceOptions {
  /**
   * The open graph's root — the metadata watch runs over it.
   */
  readonly root: string
  /**
   * The open graph's generation — every sweep is pinned to it.
   */
  readonly generation: number
  /**
   * The open index session; sweep results reindex under it.
   */
  readonly indexGeneration: number | null
  /**
   * Install the native metadata-query watch — true on mobile, where the
   * query is the only external-change source and the conflict signal; false
   * on desktop, where the `notify` watcher already reports every iCloud
   * write and the query's container-wide gather is what pinned
   * `fileproviderd` (issue #1180; see `icloud/watch.rs`).
   */
  readonly metadataWatch: boolean
}

/**
 * The services an {@link ICloudSyncService} runs on.
 */
export interface ICloudSyncServiceDeps {
  readonly icloudNative: ICloudNativeService
  readonly fileChanges: FileChangeService
  /**
   * Applies the notes a sweep rewrote.
   */
  readonly indexLifecycle: IndexLifecycleService
  /**
   * Notes with unsaved edits; their conflicts defer to the next sweep.
   */
  readonly openDocuments: OpenDocumentsService
  readonly activity: ActivityPort
  readonly clock: ClockService
  readonly logger: LoggerService
  readonly progress: ProgressPort
}

/**
 * The iCloud sync lifecycle for one (graph, index session) — the Plan 21
 * counterpart of the backup service, and deliberately much smaller:
 * iCloud moves the files itself, so all that's left to own is *conflict*
 * handling and shadow-base bookkeeping.
 *
 * - Debounces external file-change batches into conflict sweeps
 *   (`icloud_conflicts_scan`), scoped to the arrivals themselves.
 * - Classifies external arrivals (`external` batches only: not this device's
 *   own writes, pulls, or the sweep's own output) as clean ingests,
 *   which advance the notes' shadow merge bases.
 * - Fans a sweep's rewrites to every file-change subscriber and reindexes
 *   them directly, exactly like the backup service's pull path.
 * - Sweeps everything again on resume/focus: a conflict version can appear
 *   without the working file changing, which no file watcher can see. The
 *   resume sweep is the backstop for that — on desktop the only one, and
 *   the same one graphs kept outside the app's container always relied on.
 * - On mobile only ({@link ICloudSyncServiceOptions.metadataWatch}): starts
 *   and stops the native metadata-query watch, sweeps promptly on its
 *   `icloud:conflicts` signal (scoped to the watch's candidate set), and
 *   restarts the watch on every foreground resume — a long iOS suspension
 *   can sever the query's link to `fileproviderd` and update delivery never
 *   recovers, and the query is the *sole* external-change source there, so
 *   a silently dead watch means a Mac edit synced while backgrounded stays
 *   invisible until the app is relaunched.
 *
 * Dirty open sessions are deferred: their paths ride `skipPaths`.
 */
export interface ICloudSyncService {
  start(): MaybePromise<void>
  /**
   * Tear everything down; the service is unusable afterwards.
   */
  dispose(): void
}

class ICloudSyncServiceImpl implements ICloudSyncService {
  readonly #deps: ICloudSyncServiceDeps
  readonly #options: ICloudSyncServiceOptions
  readonly #disposers: Unlisten[] = []
  /**
   * The narrow scope for arrival-driven sweeps: the watch's candidate set
   * where a watch runs, else the arrivals themselves. Everything that is
   * not `'full'` merges to this one value, so a queued replay can never be
   * narrower than what this surface can actually answer.
   */
  readonly #arrivalScope: IcloudSweepScope
  #disposed = false
  #baselinePending = true
  #pendingIngest = new Set<string>()
  #scanTimer: TimerHandle | null = null
  #scanTimerDue = 0
  #scanRunning = false
  /**
   * The request that arrived while a sweep was running, replayed on its own
   * window once the sweep ends: `'prompt'` urgency (conflict signal, resume)
   * reschedules on {@link SCAN_DEBOUNCE_MS}; `'ingest'` (arrival batches)
   * respects the full ingest spacing. Requests that land mid-sweep don't arm
   * a timer — the request survives instead, so a long sweep neither chains
   * straight into the next one (ingest) nor delays conflict handling by the
   * wide window (prompt). The requested scope rides along and merges the
   * same way scopes always merge (`'full'` is sticky). Mechanically the
   * sweep's coverage always comes from `#nextScanScope`; what carrying
   * the scope prevents is the replay's `#scheduleScan` call passing the
   * *default* `'full'` and re-arming the sticky flag — which turned every
   * mid-sweep conflict signal into another O(N) version pass, in exactly
   * the overlap case the scoping exists for.
   */
  #queuedScan: { urgency: 'prompt' | 'ingest'; scope: IcloudSweepScope } | null = null
  #lastScanEndedAt = 0
  /**
   * Version-check coverage for the next sweep. `'full'` is sticky until a
   * sweep consumes it — a resume request must not be narrowed by a later
   * conflict signal — and the initial baseline sweep starts full. After each
   * sweep the scope relaxes to `'candidates'` (the watch's conflicted set;
   * Rust degrades it to full whenever the watch can't answer), and a failed
   * sweep re-arms `'full'` so the retry is thorough.
   */
  #nextScanScope: IcloudSweepScope = 'full'

  constructor(deps: ICloudSyncServiceDeps, options: ICloudSyncServiceOptions) {
    this.#deps = deps
    this.#options = options
    this.#arrivalScope = options.metadataWatch ? 'candidates' : 'ingested'
  }

  async start(): Promise<void> {
    const { icloudNative, fileChanges, activity, logger } = this.#deps
    const { root, metadataWatch } = this.#options
    if (this.#disposed) {
      return
    }
    if (metadataWatch) {
      try {
        await icloudNative.watchStart(root)
      } catch (err) {
        logger.error('iCloud watch failed to start:', err)
        // Sweeps still run off file-change batches; carry on.
      }
    }
    // Subscriptions are defensive like the watch above: a failed listen must
    // not reject start() (an unhandled rejection at the provider's call site)
    // or skip the initial sweep below — resume triggers and the baseline scan
    // keep conflict handling alive without them.
    try {
      this.#disposers.push(
        fileChanges.subscribe(({ changes, source }) => {
          if (this.#disposed || source !== 'external') {
            return
          }
          for (const change of changes) {
            if (change.kind !== 'upsert' || !isNotePath(change.path)) {
              continue
            }
            this.#pendingIngest.add(change.path)
          }
          // Arrival-driven: the wide window plus the minimum spacing, so a
          // download burst folds into a handful of sweeps rather than one
          // per watch batch.
          this.#scheduleIngestScan()
        }),
      )
      if (metadataWatch) {
        this.#disposers.push(
          icloudNative.subscribeConflicts(() => {
            if (!this.#disposed) {
              // The signal and the candidate set come from the same
              // notification round, so the flagged paths are already in the
              // watch's view — the prompt sweep needn't re-check every note.
              this.#scheduleScan(SCAN_DEBOUNCE_MS, 'candidates')
            }
          }),
        )
        this.#disposers.push(
          icloudNative.subscribeWatchFailed(() => {
            if (this.#disposed) {
              return
            }
            // The live watch never started (fire-and-forget install failed
            // after the command returned). Freshness now rides file-change
            // batches and the resume sweeps — say so loudly for debugging
            // stale-state reports, and sweep once right away.
            logger.error('iCloud watch failed to start; relying on resume-triggered sweeps')
            this.#scheduleScan()
          }),
        )
      }
    } catch (err) {
      logger.error('iCloud change subscriptions failed to start:', err)
    }
    this.#disposers.push(
      activity.subscribeResume(() => {
        if (metadataWatch) {
          void this.#restartWatch()
        }
        this.#scheduleScan()
      }),
    )
    // The adoption baseline + any conflicts that accrued while closed.
    this.#scheduleScan()
  }

  dispose(): void {
    const { clock } = this.#deps
    const { metadataWatch } = this.#options
    this.#disposed = true
    if (this.#scanTimer !== null) {
      clock.clearTimeout(this.#scanTimer)
      this.#scanTimer = null
    }
    for (const disposeOne of this.#disposers.splice(0)) {
      disposeOne()
    }
    if (metadataWatch) {
      void this.#stopWatch()
    }
  }

  async #stopWatch(): Promise<void> {
    const { icloudNative, logger } = this.#deps
    try {
      await icloudNative.watchStop()
    } catch (err: unknown) {
      // Shutdown/switch race: the next start replaces the watch anyway.
      logger.warn('stopping the iCloud metadata watch failed:', err)
    }
  }

  #scanSuspended(): boolean {
    const { activity } = this.#deps
    const { metadataWatch } = this.#options
    return metadataWatch && activity.isHidden()
  }

  #scheduleScan(delayMs: number = SCAN_DEBOUNCE_MS, scope: IcloudSweepScope = 'full'): void {
    const { clock } = this.#deps
    if (this.#disposed || this.#scanSuspended()) {
      return
    }
    if (scope === 'full') {
      this.#nextScanScope = 'full' // sticky until a sweep consumes it
    }
    if (this.#scanRunning) {
      const urgency = delayMs <= SCAN_DEBOUNCE_MS ? 'prompt' : 'ingest'
      this.#queuedScan = {
        urgency:
          urgency === 'prompt' || this.#queuedScan?.urgency === 'prompt' ? 'prompt' : 'ingest',
        scope: scope === 'full' || this.#queuedScan?.scope === 'full' ? 'full' : this.#arrivalScope,
      }
      return
    }
    const due = clock.now() + delayMs
    if (this.#scanTimer !== null) {
      if (due >= this.#scanTimerDue) {
        return // a sooner (or equal) scan is already on its way
      }
      clock.clearTimeout(this.#scanTimer)
    }
    this.#scanTimerDue = due
    this.#scanTimer = clock.setTimeout(() => {
      this.#scanTimer = null
      void this.#runScan()
    }, delayMs)
  }

  /**
   * Arrival-triggered sweeps: the wide debounce, stretched further to keep
   * {@link INGEST_SCAN_MIN_SPACING_MS} from the previous sweep's end. Scoped
   * to `#arrivalScope` — during a bulk sync these fire every spacing
   * window, and a full per-note version check each time was the sweep's
   * dominant cost on a large graph.
   */
  #scheduleIngestScan(scope: IcloudSweepScope = this.#arrivalScope): void {
    const { clock } = this.#deps
    const sinceLastScan = clock.now() - this.#lastScanEndedAt
    this.#scheduleScan(
      Math.max(INGEST_SCAN_DEBOUNCE_MS, INGEST_SCAN_MIN_SPACING_MS - sinceLastScan),
      scope,
    )
  }

  async #runScan(): Promise<void> {
    const { icloudNative, openDocuments, clock, logger, progress } = this.#deps
    const { generation } = this.#options
    if (this.#disposed || this.#scanSuspended()) {
      return
    }
    if (this.#scanRunning) {
      // Unreachable in the current shape (mid-run requests never arm a
      // timer), kept as a safe fallback: replay promptly and thoroughly.
      this.#queuedScan = { urgency: 'prompt', scope: 'full' }
      return
    }
    this.#scanRunning = true
    const ingested = [...this.#pendingIngest]
    this.#pendingIngest = new Set()
    const recordBaseline = this.#baselinePending
    this.#baselinePending = false
    const scope = recordBaseline ? 'full' : this.#nextScanScope
    this.#nextScanScope = this.#arrivalScope // consumed; the next full trigger re-arms it
    try {
      const outcome = await icloudNative.conflictsScan({
        generation,
        skipPaths: openDocuments.dirtyPaths(),
        ingestedPaths: ingested,
        recordBaseline,
        scope,
      })
      if (!this.#disposed && outcome.changed.length > 0) {
        this.#applySweepChanges(outcome.changed)
      }
      if (!this.#disposed && outcome.copies.length > 0) {
        progress.fail('Syncing', describeConflictCopies(outcome.copies))
      }
    } catch (err) {
      // A failed sweep leaves versions unresolved; the next signal retries.
      logger.error('iCloud conflict sweep failed:', err)
      for (const path of ingested) {
        this.#pendingIngest.add(path) // don't lose the base advances
      }
      if (recordBaseline) {
        this.#baselinePending = true // the adoption baseline must survive a failed first sweep
      }
      this.#nextScanScope = 'full' // whatever failed, retry thoroughly
    } finally {
      this.#lastScanEndedAt = clock.now()
      this.#scanRunning = false
      if (this.#queuedScan !== null) {
        const replay = this.#queuedScan
        this.#queuedScan = null
        if (replay.urgency === 'prompt') {
          this.#scheduleScan(SCAN_DEBOUNCE_MS, replay.scope)
        } else {
          this.#scheduleIngestScan(replay.scope)
        }
      }
    }
  }

  /**
   * Fan sweep rewrites out to every file-change subscriber (open sessions
   * reconcile from these) *and* reindex them under the open index session,
   * exactly like the backup service's pull path — the sweep must never
   * wait on the watcher to notice its own writes.
   */
  #applySweepChanges(changes: FileChange[]): void {
    const { fileChanges, indexLifecycle, activity } = this.#deps
    const { generation, indexGeneration, metadataWatch } = this.#options
    fileChanges.emit({ changes, source: 'icloud-sweep' })
    const indexable = changes.filter((change) => isNotePath(change.path))
    if (indexGeneration !== null && indexable.length > 0) {
      void indexLifecycle.applyChanges(
        indexable,
        indexGeneration,
        generation,
        () => !metadataWatch || !activity.isHidden(),
      )
    }
  }

  /**
   * Tear down and reinstall the metadata watch — the mobile resume recovery.
   * A stop/start pair is the canonical cure for a post-suspension
   * NSMetadataQuery that has stopped delivering updates: the Rust epoch
   * lifecycle serializes rapid restarts, the fresh gather round emits one
   * coarse `index:reconcile` (folded into the resume's own refresh), and the
   * live query then reports the remote metadata whenever `fileproviderd`
   * learns of it — which closes the resume race where the nudge-and-poll
   * backstop runs before the OS even knows a newer version exists.
   */
  async #restartWatch(): Promise<void> {
    const { icloudNative, logger } = this.#deps
    const { root } = this.#options
    try {
      await icloudNative.watchStop()
    } catch (err) {
      // A failed stop must not abort the restart: the Rust install tears
      // down any live watch itself, so starting over a possibly-live query
      // is safe — and the reinstall is the half that matters here.
      logger.error('iCloud watch stop failed during restart:', err)
    }
    if (this.#disposed) {
      return // closed mid-restart: never leave a watch running for a dead graph
    }
    try {
      await icloudNative.watchStart(root)
    } catch (err) {
      // Same degradation contract as a failed initial start: freshness
      // rides file-change batches and resume sweeps (this resume already
      // scheduled one), and the next resume retries the reinstall. A
      // Rust-side install failure additionally emits `icloud:watch-failed`,
      // which the subscription above answers with an immediate sweep.
      logger.error('iCloud watch restart failed; relying on resume-triggered sweeps:', err)
    }
  }
}

export function createICloudSyncService(
  deps: ICloudSyncServiceDeps,
  options: ICloudSyncServiceOptions,
): ICloudSyncService {
  return new ICloudSyncServiceImpl(deps, options)
}
