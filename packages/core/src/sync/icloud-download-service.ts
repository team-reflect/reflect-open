import type { ClockService, TimerHandle } from '../ports/clock-service.ts'
import type { ActivityPort } from '../ports/activity-port.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import { errorMessage } from '../errors.ts'
import type { ICloudNativeService } from '../ipc/icloud-native-service.ts'
import type { Unlisten } from '../unlisten.ts'

/**
 * A resume transition fires `visibilitychange` and `focus` together in
 * WKWebView (same window as the git sync service's resume triggers);
 * triggers inside this window collapse into one refresh.
 */
const RESUME_REFRESH_DEDUPE_MS = 1500

/**
 * While placeholders are still pending, poll the count and reconcile the
 * moment it reaches zero — note files are small, so downloads usually land
 * within a poll or two and the Mac edit appears in seconds. Each poll is a
 * full-graph walk in Rust, so the wait doubles from this floor up to
 * {@link PENDING_POLL_MAX_MS}: the fast early ticks stay, and a slow link
 * stops paying a walk every second for the whole drain.
 */
const PENDING_POLL_MS = 1000

/**
 * The backoff ceiling between pending-count polls.
 */
const PENDING_POLL_MAX_MS = 4000

/**
 * Give up polling after this long; the metadata watch and the next resume
 * still cover stragglers (a large asset on a slow link, say).
 */
const PENDING_POLL_LIMIT_MS = 20_000

/**
 * The open iCloud graph one {@link ICloudDownloadService} keeps fresh.
 */
export interface ICloudDownloadServiceOptions {
  /**
   * The open graph's root.
   */
  readonly root: string
  /**
   * Run the ordinary full index refresh (`GraphSessionService.refreshIndex`).
   */
  readonly refreshIndex: () => void
}

/**
 * The services an {@link ICloudDownloadService} runs on.
 */
export interface ICloudDownloadServiceDeps {
  readonly icloudNative: ICloudNativeService
  readonly activity: ActivityPort
  readonly clock: ClockService
  readonly logger: LoggerService
}

/**
 * Keeps an iCloud-stored graph fresh while the mobile app is used (Plan 21).
 *
 * Mobile has no file watcher — local writes notify in-process, and for git
 * graphs remote changes only arrive through pull. iCloud is different: the
 * OS lands files in the container behind the app's back, and on iOS it
 * doesn't even download them until asked. The metadata-query watch nudges
 * downloads live while the app is open; this service covers the resume seams
 * the query can miss: on every resume it nudges the pending downloads and
 * re-runs the index reconcile, and while placeholders remain it polls the
 * pending *count* (never re-requesting), reconciling the moment downloads
 * land instead of waiting for the next resume.
 *
 * The on-open trigger only nudges: the open itself just synced the index
 * against local disk, so an immediate second full pass would repeat that
 * work — on a first sync of a large graph, at the worst possible moment.
 *
 * Downloads are sequenced notes-first: the nudge and the poll cover only
 * markdown under the note directories, and the full-scope request (assets,
 * recordings) fires once the note count drains — so a first sync's bulk
 * bytes never compete with the first index pass.
 */
export interface ICloudDownloadService {
  /**
   * Nudge the pending note downloads once and start following resumes.
   */
  start(): void
  /**
   * Stop polling and listening; the service is unusable afterwards.
   */
  dispose(): void
}

class ICloudDownloadServiceImpl implements ICloudDownloadService {
  readonly #deps: ICloudDownloadServiceDeps
  readonly #options: ICloudDownloadServiceOptions
  readonly #disposers: Unlisten[] = []
  #disposed = false
  #lastRefreshAt = 0
  #retryTimer: TimerHandle | null = null

  readonly #onResume = (): void => {
    const now = this.#deps.clock.now()
    if (now - this.#lastRefreshAt < RESUME_REFRESH_DEDUPE_MS) {
      return
    }
    this.#lastRefreshAt = now
    void this.#refresh({ reconcile: true })
  }

  constructor(deps: ICloudDownloadServiceDeps, options: ICloudDownloadServiceOptions) {
    this.#deps = deps
    this.#options = options
  }

  start(): void {
    const { activity, clock } = this.#deps
    if (this.#disposed) {
      return
    }
    // Once on open: the reconcile that ran at open indexed what was already
    // local, so this pass only asks iCloud for the rest — the poll (or the
    // live watch) reconciles once something actually lands.
    this.#lastRefreshAt = clock.now()
    void this.#refresh({ reconcile: false })
    this.#disposers.push(
      activity.subscribeFocus(this.#onResume),
      activity.subscribeVisible(this.#onResume),
    )
  }

  dispose(): void {
    this.#disposed = true
    if (this.#retryTimer !== null) {
      this.#deps.clock.clearTimeout(this.#retryTimer)
    }
    for (const disposeOne of this.#disposers.splice(0)) {
      disposeOne()
    }
  }

  // Notes download first; everything else (assets are most of the bytes)
  // is requested only once the note placeholders drain. Kicking thousands
  // of concurrent downloads at open put the whole first sync — network,
  // disk, file coordination — under the first index pass, and the app
  // crawled until it finished. Fire-and-forget: nothing polls or
  // reconciles for assets (they aren't indexed; images appear as they
  // land), and a failed request is retried by the next resume's drain.
  async #requestRemainingDownloads(): Promise<void> {
    const { icloudNative, logger } = this.#deps
    try {
      await icloudNative.downloadPending(this.#options.root, 'all')
    } catch (err: unknown) {
      logger.error('iCloud asset download request failed:', errorMessage(err))
    }
  }

  #pollPending(startedAt: number, attempt: number): void {
    const { clock } = this.#deps
    if (this.#retryTimer !== null) {
      return
    }
    const delayMs = Math.min(PENDING_POLL_MS * 2 ** attempt, PENDING_POLL_MAX_MS)
    this.#retryTimer = clock.setTimeout(() => void this.#checkPending(startedAt, attempt), delayMs)
  }

  async #checkPending(startedAt: number, attempt: number): Promise<void> {
    const { icloudNative, activity, clock, logger } = this.#deps
    const { root, refreshIndex } = this.#options
    this.#retryTimer = null
    if (this.#disposed) {
      return
    }
    if (activity.isHidden()) {
      // Backgrounded mid-drain: stop rather than keep walking the graph
      // behind a hidden webview (every sibling service suspends on
      // hidden). The next resume restarts the whole sequence — clear the
      // dedupe stamp so even a resume inside the dedupe window counts
      // (otherwise a quick hide → show would leave nothing scheduled).
      this.#lastRefreshAt = 0
      return
    }
    let pending: number
    try {
      pending = await icloudNative.pendingCount(root, 'notes')
    } catch (err: unknown) {
      logger.error('iCloud pending poll failed:', errorMessage(err))
      if (!this.#disposed) {
        refreshIndex()
      }
      return
    }
    if (this.#disposed) {
      return
    }
    if (pending === 0) {
      // The notes landed — one reconcile picks the batch up
      // together, and the deferred bulk (assets) may start.
      refreshIndex()
      await this.#requestRemainingDownloads()
      return
    }
    if (clock.now() - startedAt >= PENDING_POLL_LIMIT_MS) {
      // Done waiting (a slow link): index what landed. The asset
      // request stays deferred — it would compete with the notes
      // still downloading; the next resume retries the sequence.
      refreshIndex()
      return
    }
    this.#pollPending(startedAt, attempt + 1)
  }

  async #refresh(refreshOptions: { reconcile: boolean }): Promise<void> {
    const { icloudNative, clock, logger } = this.#deps
    const { root, refreshIndex } = this.#options
    let pending = 0
    let nudged = false
    try {
      pending = await icloudNative.downloadPending(root, 'notes')
      nudged = true
    } catch (err) {
      // Best-effort: reconcile anyway — already-downloaded changes still land.
      logger.error('iCloud download nudge failed:', errorMessage(err))
    }
    if (this.#disposed) {
      return
    }
    if (refreshOptions.reconcile) {
      refreshIndex()
    }
    if (pending > 0) {
      this.#pollPending(clock.now(), 0)
    } else if (nudged) {
      // A confirmed-empty note count — never a failed nudge, which would
      // start the bulk while notes may still be pending. The next resume
      // retries the whole sequence.
      await this.#requestRemainingDownloads()
    }
  }
}

export function createICloudDownloadService(
  deps: ICloudDownloadServiceDeps,
  options: ICloudDownloadServiceOptions,
): ICloudDownloadService {
  return new ICloudDownloadServiceImpl(deps, options)
}
