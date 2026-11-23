import type { MaybePromise } from '@reflect/utils'
import type { GraphRole, GraphSession } from '../graph/graph-session.ts'
import type { PlatformFacts } from '../ports/platform-facts.ts'
import { isMobilePlatform } from '../ports/platform-facts.ts'
import type { ActivityPort } from '../ports/activity-port.ts'
import type { OperationHandle, ProgressPort } from '../ports/progress-port.ts'
import { errorMessage, toAppError } from '../errors.ts'
import { WritableStore, type Store } from '../store.ts'
import type { Unlisten } from '../unlisten.ts'
import type { FileChange, FileChangeService } from './file-change-service.ts'
import { createNoteIndexer, type NoteIndexer } from './indexer.ts'
import { createDirtySet } from './dirty-set.ts'
import {
  createIndexWriter,
  type IndexingDeps,
  type IndexWriter,
  type IndexWriterDeps,
} from './index-writer.ts'
import { followFileChanges, markFileChanges } from './live.ts'
import { noop } from '@ocavue/utils'

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
   * The applied changes (note changes and asset-file changes, each with its
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
   * Background-sync the open index of `session`: follow the file-change
   * stream until the session ends, sync the whole graph (hash reconcile, or a
   * full rebuild when the stored projection version is stale), then start the
   * Rust watcher. The stream and the pass both mark files dirty and the index
   * writer of the session writes them, so index writes never run concurrently
   * and a change reported during a pass is written. The pass bails between
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
   * Fully close the active index lifecycle: abort any reconcile, stop
   * following the file-change stream, stop the file watcher, and report idle
   * progress.
   */
  close(): Promise<void>
  /**
   * Suspend index writes for a backgrounded mobile app: abort the bulk pass,
   * pause the index writer, and stop following the file-change stream
   * synchronously. A later {@link IndexLifecycleService.resume} follows it
   * again and reconciles the whole graph, so file events missed while
   * suspended converge.
   */
  suspend(): void
  /**
   * Resume after {@link IndexLifecycleService.suspend} and run one coalesced
   * full sync for anything that changed while the file-change stream was not
   * followed. A null session, or one without an index, clears suspension
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
   * How far the sync pass has progressed. A bailed (superseded) pass changes
   * nothing further: the newer open's pass owns the indicator.
   */
  readonly progress: Store<IndexLifecycleProgress>
  /**
   * Listen for changes the index applied: once when a sync pass commits
   * (`changes: null`), then once per run of the index writer, with the note
   * and asset files that run settled (even when no row changed), and for the
   * notes an asset description write re-indexed. A reported change that
   * failed to apply is left out. Fires after the rows are written, so a cache
   * refetch never reads stale rows. A follower must drop events of a
   * `generation` other than its own.
   */
  onApplied(listener: (event: IndexAppliedEvent) => void): Unlisten
  /**
   * Listen for whole-graph passes that ran to completion. A sync pass reports
   * right after its {@link IndexLifecycleService.onApplied}; one that was
   * aborted, superseded, or suspended never reports. The pass has the index
   * writer read the changed files but emits no per-file change events, so
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
   * Mark the note and asset files of `changes` dirty for the index session
   * at `generation`, without waiting for the watcher: files a pull wrote must
   * reach the index even before the watcher runs. The index writer reads the
   * notes at `fileGeneration` and writes their rows in the background;
   * {@link IndexLifecycleService.drained} resolves once it has. Marking a
   * file the watcher also reports is idempotent.
   */
  markDirty(changes: readonly FileChange[], generation: number, fileGeneration: number): void
  /**
   * Resolve once the index writer has no dirty file left to write: each one
   * is written, or the index is suspended.
   */
  drained(): Promise<void>
  /**
   * Listen for id-based heals that relocate a note's rows (Plan 17): an
   * external rename observed by the reconcile or the index writer. The app
   * carries live sessions and rewrites routes off this, exactly as for an
   * in-app rename.
   */
  onMoved(listener: (from: string, to: string) => void): Unlisten
  /**
   * Listen for iCloud-evicted notes whose content the index lacks (see
   * `IndexPassOptions.onStalePlaceholders`). The app requests targeted
   * downloads for exactly these paths.
   */
  onStalePlaceholders(listener: (paths: readonly string[]) => void): Unlisten
  /**
   * The running sync pass's file progress, or `null` when no pass is
   * reconciling. Published apart from {@link IndexLifecycleService.progress}
   * on purpose: ticks arrive several times a second during a first index, and
   * only the status pill should re-render per tick.
   */
  readonly fileProgress: Store<IndexFileProgress | null>
  /**
   * Full index rebuild with user-visible status: wipe and re-derive the SQLite
   * projection from the markdown files, then report
   * {@link IndexLifecycleService.onReconciled} with `source: 'rebuild'`. The
   * index is a rebuildable cache: a full rebuild is always safe and never
   * touches the notes themselves. A rebuild that failed, or that the index
   * suspension interrupted, fails its operation and resolves without
   * reporting.
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
   * Mark one note dirty and wait until the index writer wrote it, without
   * waiting for the watcher. For an in-app write whose row must be readable
   * at once. `content` saves the read, which otherwise carries
   * `fileGeneration`; the write carries the index `generation`. Rejects when
   * the read or the write failed. Resolves without a write while the index is
   * suspended; the note stays dirty.
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
  readonly graphSession: Store<{ readonly session: GraphSession | null }>
  readonly activity: ActivityPort
  readonly platform: PlatformFacts
  readonly role: GraphRole
}

class IndexLifecycleServiceImpl implements IndexLifecycleService {
  readonly #deps: IndexLifecycleDeps
  readonly #appliedListeners = new Set<(event: IndexAppliedEvent) => void>()
  readonly #reconciledListeners = new Set<(event: IndexReconciledEvent) => MaybePromise<void>>()
  readonly #movedListeners = new Set<(from: string, to: string) => void>()
  readonly #stalePlaceholderListeners = new Set<(paths: readonly string[]) => void>()
  readonly #indexer: NoteIndexer
  readonly #writerDeps: IndexWriterDeps
  #writer: IndexWriter | null = null
  readonly #fileProgress = new WritableStore<IndexFileProgress | null>(
    null,
    (a, b) => a?.done === b?.done && a?.total === b?.total && a?.worked === b?.worked,
  )
  readonly fileProgress: Store<IndexFileProgress | null> = this.#fileProgress
  readonly #progress = new WritableStore<IndexLifecycleProgress>('idle')
  readonly progress: Store<IndexLifecycleProgress> = this.#progress
  #abort: AbortController | null = null
  #done: Promise<void> = Promise.resolve()
  #suspended = false
  #suspendGuard: (() => boolean) | null = null
  #following: { readonly writer: IndexWriter; readonly stop: Unlisten } | null = null
  #refreshRunning = false
  #refreshQueued = false
  #rebuildInFlight: { generation: number; promise: Promise<void> } | null = null
  #tooNewNotice: OperationHandle | null = null

  constructor(deps: IndexLifecycleDeps) {
    this.#deps = deps
    const emitChangesApplied = (changes: readonly FileChange[], generation: number): void => {
      this.#emitApplied({ generation, changes })
    }
    this.#indexer = createNoteIndexer(deps)
    this.#writerDeps = {
      ...deps,
      emitChangesApplied,
      emitMoved: (from, to) => {
        this.#emitMoved(from, to)
      },
      canWrite: () => !this.#isSuspended(),
    }
  }

  async open(): Promise<number | null> {
    this.#tooNewNotice?.dismiss()
    this.#tooNewNotice = null
    try {
      return await this.#deps.indexStore.open()
    } catch (error) {
      this.#reportError('open', error)
      if (toAppError(error).kind === 'indexTooNew') {
        this.#showTooNewNotice()
      }
      return null
    }
  }

  sync(session: GraphSession): void {
    const { clock, logger, fileChanges } = this.#deps
    const { indexGeneration: generation, generation: fileGeneration } = session
    const isStale = (): boolean => session.signal.aborted
    if (generation === null) {
      // No index: a writer of the previous graph must not stay bound to the stream.
      this.#dropWriter()
      return
    }
    if (this.#isSuspended()) {
      return
    }
    const writer = this.#writerAt(generation, fileGeneration)
    if (writer === null) {
      return
    }
    session.signal.addEventListener(
      'abort',
      () => {
        this.#disposeWriter(writer)
      },
      { once: true },
    )
    this.#follow(writer)
    if (session.signal.aborted) {
      this.#disposeWriter(writer)
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
      try {
        if (this.#isSuspended()) {
          return
        }
        const completed = await this.#indexer.sync({
          writer,
          signal: controller.signal,
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
              this.#fileProgress.set({ done: progressDone, total, worked })
            }
          },
        })
        // Superseded passes (aborted, stale under a newer open, or suspended
        // mid-flight) resolve early with partial counters — logging them as
        // "finished" would misread as a fast healthy pass.
        if (!completed) {
          return
        }
        if (!controller.signal.aborted && !isStale() && !this.#isSuspended()) {
          logger.info(
            `index: pass finished in ${Math.round(clock.monotonicNow() - passStarted)}ms — read ${passWorked} of ${passTotal} files`,
          )
        }
        // Aborted counts as superseded at every step below: `stop()` aborts
        // without making `isStale()` true, and every caller that stops a pass
        // (`refresh`, `close`, a graph switch) either starts a replacement pass
        // or tears the lifecycle down. Letting a stopped pass start the
        // watcher and reload every open note is churn the replacement pass
        // immediately undoes and redoes. The watcher itself is left running:
        // only `close` wants it stopped, and it stops the watcher itself.
        if (controller.signal.aborted || isStale() || this.#isSuspended()) {
          return
        }
        this.#emitApplied({ generation, changes: null })
        for (const listener of this.#reconciledListeners) {
          void listener({ generation, fileGeneration, source: 'sync' })
        }
        await fileChanges.startWatcher()
        if (controller.signal.aborted || isStale() || this.#isSuspended()) {
          return
        }
        this.#emitProgress('live')
      } catch (error) {
        this.#reportError('sync', error)
        if (!isStale()) {
          this.#emitProgress('idle')
        }
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
    await this.#done.catch(noop)
  }

  async settled(): Promise<void> {
    await this.#done.catch(noop)
  }

  async close(): Promise<void> {
    await this.stop()
    this.#dropWriter()
    this.#suspended = false
    this.#emitProgress('idle')
    try {
      await this.#deps.fileChanges.stopWatcher()
    } catch (error: unknown) {
      // Stopping is best effort: the watcher may already be gone.
      this.#deps.logger.warn('stopping the file watcher failed:', error)
    }
  }

  suspend(): void {
    this.#suspended = true
    this.#abort?.abort()
    this.#writer?.pause()
    this.#unfollow()
    this.#emitProgress('idle')
  }

  resume(session: GraphSession | null): void {
    this.#suspended = false
    this.#writer?.resume()
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
      return noop
    }
    // The lifecycle events perform the active teardown; this dynamic guard
    // also closes the launch race where the first sync is scheduled after iOS
    // has already hidden the webview.
    this.setSuspendGuard(() => activity.isHidden())
    if (activity.isHidden()) {
      this.suspend()
    }
    // A session that opens while hidden starts suspended.
    let indexGeneration = graphSession.get().session?.indexGeneration ?? null
    const stopSession = graphSession.subscribe(() => {
      const next = graphSession.get().session?.indexGeneration ?? null
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
      this.resume(graphSession.get().session)
    })
    return () => {
      stopSession()
      stopHidden()
      stopVisible()
      this.setSuspendGuard(null)
    }
  }

  onApplied(listener: (event: IndexAppliedEvent) => void): Unlisten {
    return attach(this.#appliedListeners, listener)
  }

  markDirty(changes: readonly FileChange[], generation: number, fileGeneration: number): void {
    const writer = this.#writerAt(generation, fileGeneration)
    if (writer !== null) {
      markFileChanges(writer.dirty, changes)
    }
  }

  async drained(): Promise<void> {
    await this.#writer?.drained()
  }

  onReconciled(listener: (event: IndexReconciledEvent) => MaybePromise<void>): Unlisten {
    return attach(this.#reconciledListeners, listener)
  }

  onMoved(listener: (from: string, to: string) => void): Unlisten {
    return attach(this.#movedListeners, listener)
  }

  onStalePlaceholders(listener: (paths: readonly string[]) => void): Unlisten {
    return attach(this.#stalePlaceholderListeners, listener)
  }

  rebuildVisibly(): Promise<void> {
    const { session } = this.#deps.graphSession.get()
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
    const writer = this.#writerAt(options.generation, options.fileGeneration)
    if (writer === null) {
      return
    }
    writer.dirty.add(path, { content: options.content, modifiedMs: options.mtime })
    const outcome = await writer.settled(path)
    if (outcome.status === 'failed') {
      throw outcome.error
    }
  }

  async reindexNotesReferencing(
    assetPaths: readonly string[],
    options: { generation: number; fileGeneration: number },
  ): Promise<void> {
    const writer = this.#writerAt(options.generation, options.fileGeneration)
    if (writer !== null) {
      await this.#indexer.reindexNotesReferencing(assetPaths, writer)
    }
  }

  #emitApplied(event: IndexAppliedEvent): void {
    for (const listener of this.#appliedListeners) {
      listener(event)
    }
  }

  #emitProgress(progress: IndexLifecycleProgress): void {
    if (progress !== 'reconciling') {
      this.#fileProgress.set(null) // the pass finished (or went idle): clear the pill
    }
    this.#progress.set(progress)
  }

  #emitMoved(from: string, to: string): void {
    for (const listener of this.#movedListeners) {
      listener(from, to)
    }
  }

  #showTooNewNotice(): void {
    const notice = this.#deps.progress.start('Search index unavailable', {
      persistent: true,
      action: { label: 'Dismiss', run: () => notice.dismiss() },
    })
    notice.fail(
      'A newer version of Reflect updated this graph. Update Reflect to use search, backlinks, and tasks.',
    )
    this.#tooNewNotice = notice
  }

  #reportError(stage: IndexLifecycleStage, error: unknown): void {
    this.#deps.logger.error(`index ${stage} failed:`, errorMessage(error))
  }

  #isSuspended(): boolean {
    return this.#suspended || this.#suspendGuard?.() === true
  }

  /**
   * The writer of the index session at `generation`. A newer generation
   * replaces the current writer; an older one has no writer.
   */
  #writerAt(generation: number, fileGeneration: number): IndexWriter | null {
    const current = this.#writer
    if (current !== null && current.generation === generation) {
      return current
    }
    if (current !== null && current.generation > generation) {
      return null
    }
    if (current !== null) {
      this.#disposeWriter(current)
    }
    const writer = createIndexWriter(this.#writerDeps, {
      dirty: createDirtySet(),
      generation,
      fileGeneration,
    })
    if (this.#suspended) {
      writer.pause()
    }
    this.#writer = writer
    return writer
  }

  /**
   * Mark the files that the file-change stream reports dirty in `writer`,
   * until the writer is disposed.
   */
  #follow(writer: IndexWriter): void {
    if (this.#following?.writer === writer) {
      return
    }
    this.#unfollow()
    this.#following = { writer, stop: followFileChanges(this.#deps.fileChanges, writer.dirty) }
  }

  #unfollow(): void {
    this.#following?.stop()
    this.#following = null
  }

  #disposeWriter(writer: IndexWriter): void {
    writer.dispose()
    if (this.#following?.writer === writer) {
      this.#unfollow()
    }
  }

  #dropWriter(): void {
    if (this.#writer !== null) {
      this.#disposeWriter(this.#writer)
      this.#writer = null
    }
  }

  async #runRebuild(generation: number, fileGeneration: number): Promise<void> {
    const { progress, logger } = this.#deps
    const writer = this.#writerAt(generation, fileGeneration)
    if (writer === null) {
      return
    }
    const operation = progress.start('Rebuilding search index')
    const skippedNotes: string[] = []
    try {
      const completed = await this.#indexer.rebuild({
        writer,
        onSkippedNote: (note) => {
          // The status toast lingers only briefly and samples the first few, so
          // log every skip in full — this is the durable record of which notes
          // fell out of the index and why.
          logger.warn(`Index rebuild skipped ${note.path}: ${note.message}`)
          skippedNotes.push(`${note.path}: ${note.message}`)
        },
      })
      if (!completed) {
        operation.fail('The rebuild was interrupted.')
        return
      }
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
 * `AbortController`, settlement promise, and the file-change subscription
 * internally; one instance lives across graph switches.
 */
export function createIndexLifecycleService(deps: IndexLifecycleDeps): IndexLifecycleService {
  return new IndexLifecycleServiceImpl(deps)
}
