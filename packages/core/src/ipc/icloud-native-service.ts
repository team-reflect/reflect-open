import { z } from 'zod'
import type { LoggerService } from '../ports/logger-service.ts'
import { listenNow, type IpcBridgeService } from './ipc-service.ts'
import type { Unlisten } from '../unlisten.ts'

const countSchema = z.number().int().nonnegative()

/**
 * Which placeholders a pending-download call covers: `'notes'` is markdown
 * under the note directories — what an open/resume requests first, so a
 * first sync isn't crushed under thousands of concurrent asset downloads —
 * and `'all'` is everything, requested once the notes have drained.
 */
export type IcloudDownloadScope = 'notes' | 'all'

const icloudStatusSchema = z.object({
  available: z.boolean(),
  documentsRoot: z.string().nullable(),
  /**
   * Every graph in the container (name-sorted) — onboarding lists them.
   */
  existingGraphRoots: z.array(z.string()),
})

/**
 * Whether this build can reach its iCloud Drive container (Plan 21). Dev
 * builds without the iCloud entitlement/provisioning profile honestly report
 * unavailable.
 */
export type IcloudStatus = z.infer<typeof icloudStatusSchema>

const icloudSweepChangeSchema = z.object({
  path: z.string(),
  kind: z.enum(['upsert', 'remove']),
  modifiedMs: z.number().optional(),
})

const icloudSweepOutcomeSchema = z.object({
  changed: z.array(icloudSweepChangeSchema),
  copies: z.array(z.string()),
  autoResolved: z.number().int().nonnegative(),
})

/**
 * What one iCloud conflict sweep did (Plan 21): the files it rewrote or
 * removed (reindex these directly), the graph-relative paths of the conflict
 * copies it wrote, and how many conflicts auto-resolved.
 */
export type IcloudSweepOutcome = z.infer<typeof icloudSweepOutcomeSchema>

/**
 * How much of the graph a sweep checks for unresolved versions. `'full'`
 * checks every note and runs store housekeeping — the backstop (resume,
 * adoption baseline). `'candidates'` restricts the per-note version checks
 * to the paths the live metadata watch flags as conflicted (mobile); Rust
 * degrades it to a full check whenever the watch cannot answer completely.
 * `'ingested'` restricts them to the sweep's own `ingestedPaths` — desktop's
 * arrival sweeps, where no metadata watch runs.
 */
export type IcloudSweepScope = 'full' | 'candidates' | 'ingested'

/**
 * Options for {@link ICloudNativeService.conflictsScan}.
 */
export interface IcloudScanOptions {
  /**
   * The open graph's generation — the scan is pinned to it.
   */
  generation: number
  /**
   * Notes with dirty open sessions; their conflicts defer to the next scan.
   */
  skipPaths?: string[] | undefined
  /**
   * External changes just applied cleanly — their content becomes the new
   * shadow merge base. Never pass this device's own writes.
   */
  ingestedPaths?: string[] | undefined
  /**
   * Record a fill-only baseline (adoption): notes without a base snapshot
   * their current content. Safe to repeat — existing bases never move here.
   */
  recordBaseline?: boolean | undefined
  /**
   * Version-check coverage; defaults to `'full'` (the safe backstop).
   */
  scope?: IcloudSweepScope | undefined
}

/**
 * The Rust iCloud watch's conflict event (Plan 21 Phase 2).
 */
const ICLOUD_CONFLICTS_EVENT = 'icloud:conflicts'

/**
 * The Rust iCloud watch's install-failure event (Plan 21).
 */
const ICLOUD_WATCH_FAILED_EVENT = 'icloud:watch-failed'

const conflictsPayloadSchema = z.array(z.string())

/**
 * The native side of the iCloud Drive container (Plan 21).
 */
export interface ICloudNativeService {
  /**
   * Resolve iCloud container availability.
   */
  status(): Promise<IcloudStatus>
  /**
   * Copy the open graph into the iCloud container and return the new root
   * (Plan 21 Phase 1 move-in). The copy is count+byte verified; the original
   * graph stays untouched at its old path as the recovery copy. The caller
   * re-opens the graph at the returned root and runs a baseline conflict scan.
   */
  adoptGraph(generation: number): Promise<string>
  /**
   * Run an iCloud conflict sweep over the open graph (Plan 21 Phase 2).
   */
  conflictsScan(options: IcloudScanOptions): Promise<IcloudSweepOutcome>
  /**
   * Start the iCloud metadata-query watch over `root` (Plan 21 Phase 2): its
   * snapshot diffs emit as `index:changed` batches and conflict paths reach
   * {@link subscribeConflicts}. Mobile only — desktop's `notify` watcher
   * already reports iCloud writes, and the query's container-wide gather is
   * what pinned `fileproviderd` there (issue #1180).
   */
  watchStart(root: string): Promise<void>
  /**
   * Stop the active iCloud watch (graph switch). Idempotent.
   */
  watchStop(): Promise<void>
  /**
   * Asks iCloud to download every not-yet-local file in `scope` under `root`,
   * returning how many placeholders were found. iOS does not pull container
   * files down eagerly; call this once per open/resume for iCloud graphs, then
   * poll {@link pendingCount} while the count stays above zero.
   */
  downloadPending(root: string, scope: IcloudDownloadScope): Promise<number>
  /**
   * Counts the not-yet-local placeholders in `scope` under `root` without
   * requesting anything — the poll half of {@link downloadPending}:
   * re-requesting thousands of in-flight downloads every tick is wasted
   * traffic.
   */
  pendingCount(root: string, scope: IcloudDownloadScope): Promise<number>
  /**
   * Requests iCloud downloads for specific graph-relative paths in the active
   * graph — the reconcile's targeted follow-up for evicted notes whose index
   * rows are missing or stale. Unlike {@link downloadPending} this fetches
   * exactly the content the index lacks, so an OS-evicted graph is never
   * re-downloaded wholesale. Returns how many requests were issued; a no-op
   * for an empty list.
   */
  requestDownloads(paths: readonly string[]): Promise<number>
  /**
   * Subscribe to the iCloud watch's conflict signal: graph-relative paths the
   * metadata query currently reports as carrying unresolved conflict versions.
   * The signal is a *trigger*, not a state store — it may repeat paths across
   * batches; the subscriber debounces into a conflict sweep, which is where
   * resolution actually happens.
   */
  subscribeConflicts(listener: (paths: string[]) => void): Unlisten
  /**
   * Subscribe to the watch's install-failure signal. {@link watchStart}
   * schedules its native install onto the main thread and returns before it
   * runs, so a failed `startQuery` can't surface through the command's result
   * — it arrives here instead. Rare by construction, but on iOS the query is
   * the sole live change source, so the subscriber should fall back to
   * sweep-based freshness loudly.
   */
  subscribeWatchFailed(listener: () => void): Unlisten
}

export interface ICloudNativeServiceDeps {
  readonly ipc: IpcBridgeService
  readonly logger: LoggerService
}

class ICloudNativeServiceImpl implements ICloudNativeService {
  readonly #deps: ICloudNativeServiceDeps

  constructor(deps: ICloudNativeServiceDeps) {
    this.#deps = deps
  }

  status(): Promise<IcloudStatus> {
    return this.#deps.ipc.call('icloud_status', {}, icloudStatusSchema)
  }

  adoptGraph(generation: number): Promise<string> {
    return this.#deps.ipc.call('icloud_adopt_graph', { generation }, z.string())
  }

  conflictsScan(options: IcloudScanOptions): Promise<IcloudSweepOutcome> {
    return this.#deps.ipc.call(
      'icloud_conflicts_scan',
      {
        generation: options.generation,
        skipPaths: options.skipPaths ?? [],
        ingestedPaths: options.ingestedPaths ?? [],
        recordBaseline: options.recordBaseline ?? false,
        scope: options.scope ?? 'full',
      },
      icloudSweepOutcomeSchema,
    )
  }

  async watchStart(root: string): Promise<void> {
    await this.#deps.ipc.call('icloud_watch_start', { root }, z.null())
  }

  async watchStop(): Promise<void> {
    await this.#deps.ipc.call('icloud_watch_stop', {}, z.null())
  }

  downloadPending(root: string, scope: IcloudDownloadScope): Promise<number> {
    return this.#deps.ipc.call(
      'icloud_download_pending',
      { root, notesOnly: scope === 'notes' },
      countSchema,
    )
  }

  pendingCount(root: string, scope: IcloudDownloadScope): Promise<number> {
    return this.#deps.ipc.call(
      'icloud_pending_count',
      { root, notesOnly: scope === 'notes' },
      countSchema,
    )
  }

  async requestDownloads(paths: readonly string[]): Promise<number> {
    if (paths.length === 0) {
      return 0
    }
    return await this.#deps.ipc.call('icloud_request_downloads', { paths }, countSchema)
  }

  subscribeConflicts(listener: (paths: string[]) => void): Unlisten {
    return this.#listen(ICLOUD_CONFLICTS_EVENT, (payload) => {
      const parsed = conflictsPayloadSchema.safeParse(payload)
      if (parsed.success) {
        listener(parsed.data)
      } else {
        // Contract drift between the Rust event and this schema — loud beats
        // silently never sweeping.
        this.#deps.logger.error(`invalid ${ICLOUD_CONFLICTS_EVENT} payload:`, parsed.error)
      }
    })
  }

  subscribeWatchFailed(listener: () => void): Unlisten {
    return this.#listen(ICLOUD_WATCH_FAILED_EVENT, () => {
      listener()
    })
  }

  #listen(event: string, handler: (payload: unknown) => void): Unlisten {
    const { ipc, logger } = this.#deps
    return listenNow(
      () => ipc.listen(event, handler),
      (cause) => {
        logger.error(`${event} listener failed:`, cause)
      },
    )
  }
}

export function createICloudNativeService(deps: ICloudNativeServiceDeps): ICloudNativeService {
  return new ICloudNativeServiceImpl(deps)
}
