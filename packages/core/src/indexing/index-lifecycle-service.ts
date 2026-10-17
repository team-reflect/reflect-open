import type { MaybePromise } from '@reflect/utils'
import type { GraphRole, GraphSession, GraphSessionSource } from '../graph/graph-session.ts'
import type { PlatformFacts } from '../ports/platform-facts.ts'
import { isMobilePlatform } from '../ports/platform-facts.ts'
import type { ActivityPort } from '../ports/activity-port.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import { errorMessage } from '../errors.ts'
import { isNotePath } from '../graph/paths.ts'
import type { Unlisten } from '../unlisten.ts'
import type { FileChange, FileChangeService } from './file-change-service.ts'
import { createNoteIndexer, type IndexingDeps, type NoteIndexer } from './indexer.ts'
import { createLiveIndex, type LiveIndex } from './live.ts'

/**
 * Stage of the index lifecycle that failed.
 */
export type IndexLifecycleStage = 'open' | 'sync'

/**
 * Live progress of the background sync, for UI surfacing (Plan 06b).
 */
export type IndexLifecycleProgress = 'reconciling' | 'live' | 'idle'

/**
 * How far the running pass has advanced through the file listing.
 */
export interface IndexFileProgress {
  /**
   * Files the pass has moved past (skipped or indexed).
   */
  readonly done: number
  /**
   * Files in the listing.
   */
  readonly total: number
  /**
   * Files the pass has actually read so far (not skipped read-free). The
   * pill gates on this: a routine pass skips everything (`worked` stays 0)
   * and must never surface, no matter how large the graph.
   */
  readonly worked: number
}

/**
 * The index applied changes at `generation`.
 */
export interface IndexAppliedEvent {
  /**
   * The index generation the changes were applied at.
   */
  readonly generation: number
  /**
   * The applied batch (note changes and asset-file changes, each with its
   * kind). `null` after a sync pass commits: the pass reports no per-file
   * list, so any row may have changed.
   */
  readonly changes: readonly FileChange[] | null
}

/**
 * A whole-graph pass ran to completion at `generation`.
 */
export interface IndexReconciledEvent {
  /**
   * The index generation the pass wrote at.
   */
  readonly generation: number
  /**
   * The file generation the pass read at.
   */
  readonly fileGeneration: number
  /**
   * `sync` is a background sync pass (hash reconcile, or a rebuild for a
   * stale projection version). `rebuild` is a requested
   * {@link IndexLifecycleService.rebuildVisibly}, which wiped every derived
   * table first, the embedding tables included.
   */
  readonly source: 'sync' | 'rebuild'
}

/**
 * The active graph's index lifecycle: open, reconcile, subscribe to live
 * changes, start the watcher, coalesce refreshes, suspend and resume, publish
 * progress, and rebuild on request.
 *
 * Usage on a graph switch (the caller still gates on its own open token):
 *
 * ```ts
 * await index.stop()                       // halt the previous graph's sync pass
 * const generation = await index.open()    // open the new graph's index
 * if (stale) return
 * index.sync(session)                      // background reconcile + live watch
 * await index.close()                      // no graph/index remains active
 * ```
 *
 * Every write carries the index `generation` returned by
 * {@link IndexLifecycleService.open}, and every file read carries the session's
 * file generation; Rust no-ops a write whose generation is stale, so even a
 * pass that races a connection swap can't corrupt the newly-opened index. The lifecycle itself never throws: a failed stage is
 * logged.
 */
export interface IndexLifecycleService {
  /**
   * Open + migrate the index for the now-active graph and return its generation.
   * Best-effort: returns `null` (and logs the error) if the open fails, so
   * a broken index never blocks editing.
   */
  open(): Promise<number | null>
  /**
   * Background-sync the open index of `session`: sync the whole graph
   * (hash reconcile, or a full rebuild when the stored projection version is
   * stale), then subscribe to live file changes, then start the Rust watcher,
   * sequenced so the passes never write concurrently. The pass bails between
   * steps once `session.signal` aborts; a session without an index runs none.
   * Call only after the graph row is committed.
   */
  sync(session: GraphSession): void
  /**
   * Re-run the sync pass, coalescing concurrent triggers (resume, poll-end,
   * watch-failed can fire together): while one refresh is settling, further
   * calls fold into a single queued rerun instead of stacking abort/restart
   * cycles — on a large graph each stacked cycle was a full pass.
   */
  refresh(session: GraphSession): void
  /**
   * Abort the in-flight reconcile (if any) and wait for the sync pass to fully
   * settle, so a stale pass can't keep running into the next graph's open.
   */
  stop(): Promise<void>
  /**
   * Wait for the current sync pass (if any) to finish, without aborting it.
   * The refresh coalescer serializes reruns off this.
   */
  settled(): Promise<void>
  /**
   * Fully close the active index lifecycle: abort any reconcile, drop the live
   * subscription, stop the file watcher, and report idle progress.
   */
  close(): Promise<void>
  /**
   * Suspend index writes for a backgrounded mobile app: abort the bulk pass
   * and drop the live subscription synchronously. A later
   * {@link IndexLifecycleService.resume} reconciles the whole graph, so file
   * events missed while suspended converge.
   */
  suspend(): void
  /**
   * Resume after {@link IndexLifecycleService.suspend} and run one coalesced
   * full sync for anything that changed while the live subscription was
   * absent. A null session, or one without an index, clears suspension
   * without starting work (foreground can precede graph open).
   */
  resume(session: GraphSession | null): void
  /**
   * Install a dynamic guard for platforms that must not start index work
   * while the app is suspended; `null` removes it. Checked at every lifecycle
   * boundary in addition to the explicit
   * {@link IndexLifecycleService.suspend} transition.
   */
  setSuspendGuard(shouldSuspend: (() => boolean) | null): void
  /**
   * Mobile main window: keep index writes off while the app is hidden, and
   * recover what was missed on the way back. The returned function stops it.
   */
  followActivity(): Unlisten
  /**
   * Listen as the sync pass progresses. Bailed (superseded) passes emit
   * nothing further: the newer open's pass owns the indicator.
   */
  onProgress(listener: (progress: IndexLifecycleProgress) => void): Unlisten
  /**
   * Listen for changes the index applied: once when a sync pass commits
   * (`changes: null`), then per watcher batch (notes and asset files, even
   * when no row changed), per {@link IndexLifecycleService.applyChanges} that
   * changed a row, and for the notes an asset description write re-indexed.
   * Fires after the rows are written, so a cache refetch never reads stale
   * rows. A follower must drop events of a `generation` other than its own.
   */
  onApplied(listener: (event: IndexAppliedEvent) => void): Unlisten
  /**
   * Apply `changes` to the index at `generation` now, reading the files at
   * `fileGeneration`, without waiting for the live subscription: files a pull wrote must reach the index even before
   * the watcher runs. Applying a batch the live subscription also applies is
   * idempotent. Resolves with the number of index mutations and reports
   * {@link IndexLifecycleService.onApplied} when there was any. `canApply` is
   * checked before every write; a rejection is the caller's to handle.
   */
  applyChanges(
    changes: FileChange[],
    generation: number,
    fileGeneration: number,
    canApply?: () => boolean,
  ): Promise<number>
  /**
   * Listen for whole-graph passes that ran to completion. A sync pass reports
   * right after its {@link IndexLifecycleService.onApplied}; one that was
   * aborted, superseded, or suspended never reports. The pass reads changed
   * files straight into the index but emits no per-file change events, so
   * holders of in-memory file content (open note sessions) must be told to
   * re-read here; on iOS the resume reconcile is the only signal a remote edit
   * ever produces for an already-open note.
   *
   * A requested rebuild reports with `source: 'rebuild'` and stays in flight
   * until every listener's returned promise settles, so the work a listener
   * starts (re-embedding) is part of the same coalesced request.
   */
  onReconciled(listener: (event: IndexReconciledEvent) => MaybePromise<void>): Unlisten
  /**
   * Listen for id-based heals that relocate a note's rows (Plan 17): an
   * external rename observed by the reconcile or a watcher batch. The app
   * carries live sessions and rewrites routes off this, exactly as for an
   * in-app rename.
   */
  onMoved(listener: (from: string, to: string) => void): Unlisten
  /**
   * Listen as a sync pass advances through the file listing (`done`,
   * `total`, `worked`): the substrate for a "Preparing your notes… 400 of
   * 3,000" surface during a first index. Superseded passes stop reporting.
   */
  onFileProgress(listener: (done: number, total: number, worked: number) => void): Unlisten
  /**
   * Listen for iCloud-evicted notes whose content the index lacks (see
   * `IndexPassOptions.onStalePlaceholders`). The app requests targeted
   * downloads for exactly these paths.
   */
  onStalePlaceholders(listener: (paths: readonly string[]) => void): Unlisten
  /**
   * The running sync pass's file progress, or `null` when no pass is
   * reconciling. Published apart from {@link IndexLifecycleService.onProgress}
   * on purpose: ticks arrive several times a second during a first index, and
   * only the status pill should re-render per tick.
   */
  fileProgress: () => IndexFileProgress | null
  /**
   * Subscribe to {@link IndexLifecycleService.fileProgress} changes.
   */
  subscribeFileProgress: (listener: () => void) => Unlisten
  /**
   * Full index rebuild with user-visible status: wipe and re-derive the SQLite
   * projection from the markdown files, then report
   * {@link IndexLifecycleService.onReconciled} with `source: 'rebuild'`. The
   * index is a rebuildable cache: a full rebuild is always safe and never
   * touches the notes themselves. A failed rebuild fails its operation and
   * resolves without reporting.
   *
   * The rebuild is pinned to the index generation of the open graph, and does
   * nothing when no graph is open or its index failed to open. Requests
   * coalesce while a rebuild runs: a second call at the same generation (a
   * double-click, or the palette and the settings button racing) returns the
   * in-flight pass instead of starting an overlapping wipe. A call at a
   * *different* generation starts fresh: the graph changed, and Rust's
   * generation gate drops the superseded pass's writes anyway.
   */
  rebuildVisibly(): Promise<void>
  /**
   * Read, parse, and index one note now, without waiting for the watcher. For
   * an in-app write whose row must be readable at once. The read carries
   * `fileGeneration` and the write carries the index `generation`.
   */
  indexNote(
    path: string,
    options: {
      generation: number
      fileGeneration: number
      content?: string | undefined
      mtime?: number | undefined
    },
  ): Promise<void>
  /**
   * Re-index every note that references any of `assetPaths`, so an asset
   * description written after its notes were indexed reaches their search
   * rows. The re-applied notes report through
   * {@link IndexLifecycleService.onApplied}. Writes carry the index
   * `generation`, reads carry `fileGeneration`.
   */
  reindexNotesReferencing(
    assetPaths: readonly string[],
    options: { generation: number; fileGeneration: number },
  ): Promise<void>
}

/**
 * The services an {@link IndexLifecycleService} runs on.
 */
export interface IndexLifecycleDeps extends IndexingDeps {
  readonly fileChanges: FileChangeService
  readonly progress: ProgressPort
  readonly graphSession: GraphSessionSource & { subscribe: (listener: () => void) => Unlisten }
  readonly activity: ActivityPort
  readonly platform: PlatformFacts
  readonly role: GraphRole
}

class IndexLifecycleServiceImpl implements IndexLifecycleService {
  readonly #deps: IndexLifecycleDeps
  readonly #progressListeners = new Set<(progress: IndexLifecycleProgress) => void>()
  readonly #appliedListeners = new Set<(event: IndexAppliedEvent) => void>()
  readonly #reconciledListeners = new Set<(event: IndexReconciledEvent) => MaybePromise<void>>()
  readonly #movedListeners = new Set<(from: string, to: string) => void>()
  readonly #fileProgressListeners = new Set<(done: number, total: number, worked: number) => void>()
  readonly #stalePlaceholderListeners = new Set<(paths: readonly string[]) => void>()
  readonly #fileProgressStoreListeners = new Set<() => void>()
  readonly #indexer: NoteIndexer
  readonly #liveIndex: LiveIndex
  #currentFileProgress: IndexFileProgress | null = null
  #abort: AbortController | null = null
  #done: Promise<void> = Promise.resolve()
  #suspended = false
  #suspendGuard: (() => boolean) | null = null
  #liveUnlisten: (() => void) | null = null
  #refreshRunning = false
  #refreshQueued = false
  #rebuildInFlight: { generation: number; promise: Promise<void> } | null = null

  constructor(deps: IndexLifecycleDeps) {
    this.#deps = deps
    const emitChangesApplied = (changes: readonly FileChange[], generation: number): void => {
      this.#emitApplied({ generation, changes })
    }
    this.#indexer = createNoteIndexer({ ...deps, emitChangesApplied })
    this.#liveIndex = createLiveIndex({ ...deps, emitChangesApplied })
  }

  async open(): Promise<number | null> {
    try {
      return await this.#deps.indexStore.open()
    } catch (error) {
      this.#reportError('open', error)
      return null
    }
  }

  sync(session: GraphSession): void {
    const { clock, logger, fileChanges } = this.#deps
    const { indexGeneration: generation, generation: fileGeneration } = session
    const isStale = (): boolean => session.signal.aborted
    // Tear down the previous graph's live subscription unconditionally, so a
    // failed/absent open can't leave it bound to a different graph.
    this.#liveUnlisten?.()
    this.#liveUnlisten = null

    if (generation === null || this.#isSuspended()) {
      return
    }

    this.#emitProgress('reconciling')
    const controller = new AbortController()
    this.#abort = controller
    // Pass telemetry: `worked` (files actually read) is the one number that
    // says whether this launch took the expensive branch — a routine open
    // logs 0.
    const passStarted = clock.monotonicNow()
    let passTotal = 0
    let passWorked = 0
    this.#done = (async () => {
      // A subscription created but not yet adopted (superseded mid-flight, or a
      // later step threw) is torn down in `finally` so listeners can't leak.
      let pending: (() => void) | null = null
      try {
        if (this.#isSuspended()) {
          return
        }
        await this.#indexer.sync({
          generation,
          fileGeneration,
          signal: controller.signal,
          onMoved: (from, to) => {
            this.#emitMoved(from, to)
          },
          // Guarded: opening a graph swaps the Rust root *before* this pass is
          // stopped, so a superseded pass could otherwise request its old
          // paths against the newly opened graph.
          onStalePlaceholders: (paths: readonly string[]) => {
            if (!controller.signal.aborted && !isStale() && !this.#isSuspended()) {
              for (const listener of this.#stalePlaceholderListeners) {
                listener(paths)
              }
            }
          },
          onFileProgress: (progressDone: number, total: number, worked: number) => {
            passTotal = total
            passWorked = worked
            if (!isStale()) {
              this.#setFileProgress({ done: progressDone, total, worked })
              for (const listener of this.#fileProgressListeners) {
                listener(progressDone, total, worked)
              }
            }
          },
        })
        // Superseded passes (aborted, stale under a newer open, or suspended
        // mid-flight) resolve early with partial counters — logging them as
        // "finished" would misread as a fast healthy pass.
        if (!controller.signal.aborted && !isStale() && !this.#isSuspended()) {
          logger.info(
            `index: pass finished in ${Math.round(clock.monotonicNow() - passStarted)}ms — read ${passWorked} of ${passTotal} files`,
          )
        }
        // Aborted counts as superseded at every step below: `stop()` aborts
        // without making `isStale()` true, and every caller that stops a pass
        // (`refresh`, `close`, a graph switch) either starts a replacement pass
        // or tears the lifecycle down. Letting a stopped pass subscribe, start
        // the watcher, and reload every open note is churn the replacement pass
        // immediately undoes and redoes. The watcher itself is left running:
        // only `close` wants it stopped, and it stops the watcher itself.
        if (controller.signal.aborted || isStale() || this.#isSuspended()) {
          return
        }
        this.#emitApplied({ generation, changes: null })
        for (const listener of this.#reconciledListeners) {
          void listener({ generation, fileGeneration, source: 'sync' })
        }
        pending = this.#liveIndex.subscribe(
          generation,
          fileGeneration,
          (from, to) => {
            this.#emitMoved(from, to)
          },
          () => !controller.signal.aborted && !isStale() && !this.#isSuspended(),
        )
        if (controller.signal.aborted || isStale() || this.#isSuspended()) {
          return
        }
        await fileChanges.startWatcher()
        if (controller.signal.aborted || isStale() || this.#isSuspended()) {
          return
        }
        this.#liveUnlisten?.()
        this.#liveUnlisten = pending
        pending = null // ownership transferred
        this.#emitProgress('live')
      } catch (error) {
        this.#reportError('sync', error)
        if (!isStale()) {
          this.#emitProgress('idle')
        }
      } finally {
        pending?.()
      }
    })()
  }

  refresh(session: GraphSession): void {
    if (this.#isSuspended()) {
      return
    }
    if (this.#refreshRunning) {
      this.#refreshQueued = true
      return
    }
    this.#refreshRunning = true
    void (async () => {
      try {
        do {
          this.#refreshQueued = false
          // Settle (abort) any in-flight pass first so two passes never write
          // concurrently, then bail if a newer open superseded this graph.
          await this.stop()
          if (session.signal.aborted || this.#isSuspended()) {
            return
          }
          this.sync(session)
          await this.settled()
        } while (this.#refreshQueued)
      } finally {
        this.#refreshRunning = false
      }
    })()
  }

  async stop(): Promise<void> {
    this.#abort?.abort()
    await this.#done.catch(() => {})
  }

  async settled(): Promise<void> {
    await this.#done.catch(() => {})
  }

  async close(): Promise<void> {
    await this.stop()
    this.#liveUnlisten?.()
    this.#liveUnlisten = null
    this.#suspended = false
    this.#emitProgress('idle')
    try {
      await this.#deps.fileChanges.stopWatcher()
    } catch {
      // Stopping is best effort: the watcher may already be gone.
    }
  }

  suspend(): void {
    this.#suspended = true
    this.#abort?.abort()
    this.#liveUnlisten?.()
    this.#liveUnlisten = null
    this.#emitProgress('idle')
  }

  resume(session: GraphSession | null): void {
    this.#suspended = false
    if (session !== null && session.indexGeneration !== null && !session.signal.aborted) {
      // Events intentionally dropped while suspended are recovered by the
      // full reconcile. `refresh` also folds a rapid resume/poll burst into a
      // single queued rerun when a prior pass is still settling.
      this.refresh(session)
    }
  }

  setSuspendGuard(shouldSuspend: (() => boolean) | null): void {
    this.#suspendGuard = shouldSuspend
  }

  followActivity(): Unlisten {
    const { graphSession, activity, platform, role } = this.#deps
    if (!isMobilePlatform(platform.appPlatform) || role !== 'main') {
      return () => {}
    }
    // The lifecycle events perform the active teardown; this dynamic guard
    // also closes the launch race where the first sync is scheduled after iOS
    // has already hidden the webview.
    this.setSuspendGuard(() => activity.isHidden())
    if (activity.isHidden()) {
      this.suspend()
    }
    // A session that opens while hidden starts suspended.
    let indexGeneration = graphSession.getState().session?.indexGeneration ?? null
    const stopSession = graphSession.subscribe(() => {
      const next = graphSession.getState().session?.indexGeneration ?? null
      if (next !== indexGeneration) {
        indexGeneration = next
        if (activity.isHidden()) {
          this.suspend()
        }
      }
    })
    // Synchronous teardown prevents a locally emitted or metadata-watcher
    // batch from entering the index queue after iOS begins suspension.
    const stopHidden = activity.subscribeHidden(() => {
      this.suspend()
    })
    const stopVisible = activity.subscribeVisible(() => {
      // A null session still clears suspension: mobile can foreground
      // before onboarding/open has produced an index session. With a session,
      // the full pass recovers every event missed while hidden; stacked
      // resume/iCloud triggers fold into the lifecycle's queued rerun.
      this.resume(graphSession.getState().session)
    })
    return () => {
      stopSession()
      stopHidden()
      stopVisible()
      this.setSuspendGuard(null)
    }
  }

  onProgress(listener: (progress: IndexLifecycleProgress) => void): Unlisten {
    return attach(this.#progressListeners, listener)
  }

  onApplied(listener: (event: IndexAppliedEvent) => void): Unlisten {
    return attach(this.#appliedListeners, listener)
  }

  async applyChanges(
    changes: FileChange[],
    generation: number,
    fileGeneration: number,
    canApply?: () => boolean,
  ): Promise<number> {
    const mutations = await this.#liveIndex.apply(
      changes,
      generation,
      fileGeneration,
      undefined,
      undefined,
      canApply,
    )
    if (mutations > 0) {
      this.#emitApplied({
        generation,
        changes: changes.filter((change) => isNotePath(change.path)),
      })
    }
    return mutations
  }

  onReconciled(listener: (event: IndexReconciledEvent) => MaybePromise<void>): Unlisten {
    return attach(this.#reconciledListeners, listener)
  }

  onMoved(listener: (from: string, to: string) => void): Unlisten {
    return attach(this.#movedListeners, listener)
  }

  onFileProgress(listener: (done: number, total: number, worked: number) => void): Unlisten {
    return attach(this.#fileProgressListeners, listener)
  }

  onStalePlaceholders(listener: (paths: readonly string[]) => void): Unlisten {
    return attach(this.#stalePlaceholderListeners, listener)
  }

  readonly fileProgress = (): IndexFileProgress | null => this.#currentFileProgress

  readonly subscribeFileProgress = (listener: () => void): Unlisten =>
    attach(this.#fileProgressStoreListeners, listener)

  rebuildVisibly(): Promise<void> {
    const { session } = this.#deps.graphSession.getState()
    const generation = session?.indexGeneration ?? null
    if (session === null || generation === null) {
      return Promise.resolve()
    }
    if (this.#rebuildInFlight !== null && this.#rebuildInFlight.generation === generation) {
      return this.#rebuildInFlight.promise
    }
    const promise = this.#runRebuild(generation, session.generation).finally(() => {
      if (this.#rebuildInFlight !== null && this.#rebuildInFlight.promise === promise) {
        this.#rebuildInFlight = null
      }
    })
    this.#rebuildInFlight = { generation, promise }
    return promise
  }

  async indexNote(
    path: string,
    options: {
      generation: number
      fileGeneration: number
      content?: string | undefined
      mtime?: number | undefined
    },
  ): Promise<void> {
    await this.#indexer.indexNote(path, options)
  }

  async reindexNotesReferencing(
    assetPaths: readonly string[],
    options: { generation: number; fileGeneration: number },
  ): Promise<void> {
    await this.#indexer.reindexNotesReferencing(assetPaths, options)
  }

  #emitApplied(event: IndexAppliedEvent): void {
    for (const listener of this.#appliedListeners) {
      listener(event)
    }
  }

  #setFileProgress(progress: IndexFileProgress | null): void {
    const current = this.#currentFileProgress
    if (
      progress?.done === current?.done &&
      progress?.total === current?.total &&
      progress?.worked === current?.worked
    ) {
      return
    }
    this.#currentFileProgress = progress
    for (const listener of this.#fileProgressStoreListeners) {
      listener()
    }
  }

  #emitProgress(progress: IndexLifecycleProgress): void {
    if (progress !== 'reconciling') {
      this.#setFileProgress(null) // the pass finished (or went idle): clear the pill
    }
    for (const listener of this.#progressListeners) {
      listener(progress)
    }
  }

  #emitMoved(from: string, to: string): void {
    for (const listener of this.#movedListeners) {
      listener(from, to)
    }
  }

  #reportError(stage: IndexLifecycleStage, error: unknown): void {
    this.#deps.logger.error(`index ${stage} failed:`, errorMessage(error))
  }

  #isSuspended(): boolean {
    return this.#suspended || this.#suspendGuard?.() === true
  }

  async #runRebuild(generation: number, fileGeneration: number): Promise<void> {
    const { progress, logger } = this.#deps
    const operation = progress.start('Rebuilding search index')
    const skippedNotes: string[] = []
    try {
      await this.#indexer.rebuild({
        generation,
        fileGeneration,
        onSkippedNote: (note) => {
          // The status toast lingers only briefly and samples the first few, so
          // log every skip in full — this is the durable record of which notes
          // fell out of the index and why.
          logger.warn(`Index rebuild skipped ${note.path}: ${note.message}`)
          skippedNotes.push(`${note.path}: ${note.message}`)
        },
      })
      if (skippedNotes.length === 0) {
        operation.done()
      } else {
        const sample = skippedNotes.slice(0, 3).join('; ')
        const suffix = skippedNotes.length > 3 ? `; +${skippedNotes.length - 3} more` : ''
        operation.warn(`Rebuilt with ${skippedNotes.length} skipped note(s): ${sample}${suffix}`)
      }
    } catch (cause) {
      operation.fail(errorMessage(cause))
      return
    }
    // A manual rebuild bypasses the watcher pipeline, and `index_clear` wiped
    // the embedding tables with everything else: followers refresh their
    // caches and re-embed off this, one after another.
    for (const listener of this.#reconciledListeners) {
      await listener({ generation, fileGeneration, source: 'rebuild' })
    }
  }
}

function attach<Listener>(listeners: Set<Listener>, listener: Listener): Unlisten {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Create an {@link IndexLifecycleService}. Holds the in-flight sync's
 * `AbortController`, settlement promise, and the live-subscription unlisten
 * internally; one instance lives across graph switches.
 */
export function createIndexLifecycleService(deps: IndexLifecycleDeps): IndexLifecycleService {
  return new IndexLifecycleServiceImpl(deps)
}
