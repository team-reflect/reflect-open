import { isDeepEqual } from '@ocavue/utils'
import { z } from 'zod'
import { createGraphSession, type GraphRole, type GraphSession } from './graph-session.ts'
import type { IdService } from '../ports/id-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { NoteMoveService } from '../documents/note-move-service.ts'
import type { NoteRowService } from '../documents/note-row-service.ts'
import type { OpenDocumentsService } from '../documents/open-documents-service.ts'
import { errorMessage } from '../errors.ts'
import type { FileChangeService } from '../indexing/file-change-service.ts'
import type { IndexLifecycleService } from '../indexing/index-lifecycle-service.ts'
import type { IndexStoreService } from '../indexing/index-store-service.ts'
import type { ICloudNativeService } from '../ipc/icloud-native-service.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type { MobileStorageService } from '../ipc/mobile-storage-service.ts'
import type { NoteFileService } from './note-file-service.ts'
import { ensureWelcomeNote } from './onboarding.ts'
import { graphInfoSchema, recentGraphSchema, type GraphInfo, type RecentGraph } from './schemas.ts'

/**

 * Lifecycle of the active graph (Plan 02 loading gate).

 */
export type GraphStatus = 'loading' | 'choosing' | 'opening' | 'ready'

/**

 * Why the active graph's in-memory leftovers can go.

 */
export type GraphReleaseReason = 'switch' | 'close'

/**
 * What a {@link GraphSessionService} publishes. Replaced, never mutated, on
 * every change. `Services` is what the graph-scoped container of a session is.
 */
export interface GraphSessionState<Services = unknown> {
  readonly status: GraphStatus
  readonly graph: GraphInfo | null
  /**
   * The open **index session** generation (from `index_open`), distinct from
   * `graph.generation` (the file-write generation): the two counters are
   * independent in Rust. Null when the index failed to open.
   */
  readonly indexGeneration: number | null
  /**
   * True while the background index reconcile is running (Plan 06b).
   */
  readonly indexing: boolean
  readonly error: string | null
  readonly recents: RecentGraph[]
  /**
   * The open graph as one object; null while no graph is open. Its `signal`
   * aborts when the graph closes or another open is requested.
   */
  readonly session: GraphSession | null
  /**
   * The graph-scoped services of `session`; null whenever `session` is null or ended.
   */
  readonly services: Services | null
}

/**
 * The active graph of this webview: its identity, both session generations,
 * the open, create, close, forget and delete flows, and the recents list.
 * Members are function properties so surfaces can pass them around unbound.
 */
export interface GraphSessionService<Services = unknown> {
  getState: () => GraphSessionState<Services>
  subscribe: (listener: () => void) => Unlisten
  /**
   * Follow the index lifecycle: the indexing flag, reconcile demands, the
   * reloads, moves and downloads that its passes call for, and the app
   * activity that suspends it. The returned function stops the following.
   */
  attach(): Unlisten
  /**
   * Refresh the recents list. `surfaceErrors` publishes a failed read as the error.
   */
  loadRecents(options?: { surfaceErrors?: boolean }): Promise<RecentGraph[]>
  /**
   * Open a graph by its root path. Resolves true only when it reached 'ready';
   * false outside the main window.
   */
  openRecent(root: string): Promise<boolean>
  /**
   * Create (and open) a graph at an app-chosen absolute path. Resolves true
   * only on a confirmed open.
   */
  createGraphAt(root: string): Promise<boolean>
  /**
   * Close the active graph and stop at 'choosing'.
   */
  close(): Promise<void>
  /**
   * Commit the session that a note window adopted from the main window,
   * without opening anything.
   */
  adopt(info: GraphInfo, indexGeneration: number | null): void
  /**
   * Drop a graph from the recents list.
   */
  forgetRecent(root: string): Promise<void>
  /**
   * Move the open graph's directory to the OS trash (recoverable), drop it
   * from recents, and return to the chooser. Throws when the delete fails.
   * Desktop-only.
   */
  deleteGraph(): Promise<void>
  /**
   * Re-run the open graph's background index reconcile. No-op while no index
   * is open and outside the main window.
   */
  refreshIndex(): void
  /**
   * Stop at 'choosing' with `error`: the host's boot path could not open a graph.
   */
  park(error: string | null): void
  /**
   * Publish `error` without changing the status.
   */
  reportError(error: string): void
  /**
   * Listen for the point where the previous graph's in-memory leftovers can
   * go: `switch` once another graph's backend open settled the old index pass,
   * `close` once the active graph's index closed.
   */
  onGraphReleased(listener: (reason: GraphReleaseReason) => void): Unlisten
  /**
   * Listen for a graph directory that went to the trash.
   */
  onGraphDeleted(listener: (root: string) => void): Unlisten
}

export interface GraphSessionServiceDeps<Services = unknown> {
  readonly ipc: IpcBridgeService
  readonly indexLifecycle: IndexLifecycleService
  readonly indexStore: IndexStoreService
  readonly noteFile: NoteFileService
  readonly id: IdService
  readonly fileChanges: FileChangeService
  /**
   * Only the main window opens, creates, deletes, and indexes graphs.
   */
  readonly role: GraphRole
  readonly mobileStorage: MobileStorageService
  readonly noteRows: NoteRowService
  readonly openDocuments: OpenDocumentsService
  readonly noteMove: NoteMoveService
  readonly icloudNative: ICloudNativeService
  readonly logger: LoggerService
  /**
   * Build the graph-scoped services of a session that just opened. They must
   * dispose themselves when `session.signal` aborts. Without it, `services`
   * stays null.
   */
  readonly createServices?: (session: GraphSession) => Services
}

/**

 * Commands that return `()` from Rust serialize as `null` over IPC.

 */
const voidSchema = z.null()

class GraphSessionServiceImpl<Services = unknown> implements GraphSessionService<Services> {
  readonly #deps: GraphSessionServiceDeps<Services>
  readonly #listeners = new Set<() => void>()
  readonly #releasedListeners = new Set<(reason: GraphReleaseReason) => void>()
  readonly #deletedListeners = new Set<(root: string) => void>()
  #state: GraphSessionState<Services> = {
    status: 'loading',
    graph: null,
    indexGeneration: null,
    indexing: false,
    error: null,
    recents: [],
    session: null,
    services: null,
  }
  // Monotonic open token: only the most recent open may commit `graph`/`status`,
  // so overlapping opens (double-click, StrictMode remount) can't finish out of
  // order and leave us on a graph the user didn't pick last.
  #openSeq = 0
  // Serializes backend opens (see `openRecent`).
  #openChain: Promise<unknown> = Promise.resolve()
  // Aborts the published session's signal.
  #sessionAbort: AbortController | null = null

  constructor(deps: GraphSessionServiceDeps<Services>) {
    this.#deps = deps
  }

  readonly getState = (): GraphSessionState<Services> => this.#state

  readonly subscribe = (listener: () => void): Unlisten => this.#attach(this.#listeners, listener)

  onGraphReleased(listener: (reason: GraphReleaseReason) => void): Unlisten {
    return this.#attach(this.#releasedListeners, listener)
  }

  onGraphDeleted(listener: (root: string) => void): Unlisten {
    return this.#attach(this.#deletedListeners, listener)
  }

  #attach<Listener>(set: Set<Listener>, listener: Listener): Unlisten {
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  readonly #requestDownloads = async (paths: readonly string[]): Promise<void> => {
    try {
      await this.#deps.icloudNative.requestDownloads(paths)
    } catch (err: unknown) {
      this.#deps.logger.error('iCloud download request failed:', errorMessage(err))
    }
  }

  #setState(patch: Partial<GraphSessionState<Services>>): void {
    const next = { ...this.#state, ...patch }
    if (isDeepEqual(next, this.#state)) {
      return
    }
    this.#state = next
    for (const listener of this.#listeners) {
      listener()
    }
  }

  /**

   * Invalidate every open in flight and the published session.

   */
  #supersede(): number {
    this.#openSeq += 1
    this.#sessionAbort?.abort()
    this.#sessionAbort = null
    return this.#openSeq
  }

  /**

   * The session object of an open graph.

   */
  #sessionFor(graph: GraphInfo, indexGeneration: number | null): GraphSession {
    const controller = new AbortController()
    this.#sessionAbort?.abort()
    this.#sessionAbort = controller
    return createGraphSession(
      {
        root: graph.root,
        name: graph.name,
        generation: graph.generation,
        indexGeneration,
        role: this.#deps.role,
      },
      controller.signal,
    )
  }

  /**

   * Publish `graph` as ready, then the graph-scoped services of its session.

   */
  #commitReady(graph: GraphInfo, indexGeneration: number | null): GraphSession {
    const session = this.#sessionFor(graph, indexGeneration)
    this.#setState({ graph, indexGeneration, status: 'ready', session, services: null })
    const { createServices } = this.#deps
    if (createServices !== undefined && !session.signal.aborted) {
      try {
        this.#setState({ services: createServices(session) })
      } catch (cause) {
        // A half-open graph must not stay published: the caller reports the error.
        this.#sessionAbort?.abort()
        this.#sessionAbort = null
        this.#setState({ graph: null, indexGeneration: null, session: null, services: null })
        throw cause
      }
    }
    return session
  }

  /**

   * The prior graph's in-memory leftovers can go.

   */
  #release(reason: GraphReleaseReason): void {
    this.#deps.noteRows.reset()
    for (const listener of this.#releasedListeners) {
      listener(reason)
    }
  }

  /**
   * Guard for graph-session mutations only the main window may run: opening,
   * switching, or deleting a graph re-roots the shared Rust `GraphState` under
   * every window at once.
   */
  #requireMainRole(action: string): boolean {
    if (this.#deps.role === 'main') {
      return true
    }
    this.#deps.logger.warn(`${action} is only available from the main window`)
    return false
  }

  async loadRecents(options?: { surfaceErrors?: boolean }): Promise<RecentGraph[]> {
    try {
      const list = await this.#deps.ipc.call('recent_graphs', {}, z.array(recentGraphSchema))
      this.#setState({ recents: list })
      return list
    } catch (err) {
      // Surface a real failure (e.g. a corrupt recent-graphs.json, which Rust
      // reports as an error rather than an empty list) only when this is the
      // primary load. As a post-open refresh it must not clobber an open error
      // or set one on a screen (the workspace) that never shows it.
      if (options?.surfaceErrors) {
        this.#setState({ error: errorMessage(err) })
      }
      return []
    }
  }

  openRecent(root: string): Promise<boolean> {
    if (!this.#requireMainRole('opening a graph')) {
      return Promise.resolve(false)
    }
    const seq = this.#supersede()
    this.#setState({ status: 'opening', error: null, services: null })
    // Resolves true only when this open actually reached 'ready': callers
    // (mobile onboarding) gate side effects like persisting the onboarded
    // flag on a confirmed open, never on a clone that failed to open.
    const run = async (): Promise<boolean> => {
      let opened = false
      try {
        const info = await this.#deps.ipc.call('graph_open', { path: root }, graphInfoSchema)
        if (seq !== this.#openSeq) {
          return false // superseded by a newer open
        }
        // Stop any prior reconcile and wait for it to fully settle before the
        // Rust index connection is swapped, so a stale pass can't write into
        // this graph's index.
        await this.#deps.indexLifecycle.stop()
        // Listeners reclaim what they hold for the prior graph. It is already
        // invisible here (scoped by generation / graph root), so this is
        // memory hygiene, not correctness.
        this.#release('switch')
        // Open the index *before* 'ready' so reads can't hit the previous
        // graph's index. Best-effort: an index failure doesn't block editing.
        const generation = await this.#deps.indexLifecycle.open()
        if (seq !== this.#openSeq) {
          return false
        }
        // Transition to 'ready' immediately: the user can start editing.
        const session = this.#commitReady(info, generation)
        opened = true
        // Onboarding, considered exactly once per graph (the `welcomeSeeded`
        // meta marker): an empty graph gets the pinned "How to use Reflect"
        // note. Needs the index for the marker, so a graph whose index failed
        // to open simply tries again next time. On all launches after the
        // first, ensureWelcomeNote returns immediately (marker already set),
        // so it no longer blocks time-to-first-workspace-paint. The note must
        // land before the reconcile indexes files: index.sync starts in the
        // .finally so it always runs after the seed attempt.
        // Best-effort: a failed seed must never block opening.
        if (generation !== null) {
          ensureWelcomeNote(
            {
              indexStore: this.#deps.indexStore,
              noteFile: this.#deps.noteFile,
              id: this.#deps.id,
            },
            { fileGeneration: info.generation, indexGeneration: generation },
          )
            .catch((err: unknown) => {
              this.#deps.logger.error('welcome seed failed:', errorMessage(err))
            })
            .finally(() => {
              if (!session.signal.aborted) {
                // Background-sync the index (reconcile → subscribe → watch),
                // bailing if a newer open supersedes this one.
                this.#deps.indexLifecycle.sync(session)
              }
            })
        } else {
          // No index: tear down any live lifecycle left from the prior graph.
          void this.#deps.indexLifecycle.close()
        }
      } catch (err) {
        if (seq !== this.#openSeq) {
          return false
        }
        this.#setState({ error: errorMessage(err), status: 'choosing' })
      }
      if (seq === this.#openSeq) {
        await this.loadRecents()
      }
      return opened
    }
    // `graph_open` mutates Rust's GraphState (`set_root`), so overlapping opens
    // could otherwise have a slow older call land *after* a newer one and leave
    // the backend on a different graph than the UI. Serialize them: running
    // one-at-a-time in request order makes the last-requested open the last to
    // touch GraphState, matching the `openSeq`-pinned UI.
    const next = this.#openChain.then(run, run)
    this.#openChain = next
    return next
  }

  async createGraphAt(root: string): Promise<boolean> {
    // Guarded BEFORE the create: graph_create activates the shared Rust
    // session, so off-main it would re-root every window even though the
    // openRecent below refuses.
    if (!this.#requireMainRole('creating a graph')) {
      return false
    }
    try {
      await this.#deps.mobileStorage.createGraph(root)
    } catch (err) {
      this.#setState({ error: errorMessage(err) })
      return false
    }
    return await this.openRecent(root)
  }

  async close(): Promise<void> {
    this.#supersede()
    await this.#deps.indexLifecycle.close()
    this.#release('close')
    this.#setState({
      graph: null,
      indexGeneration: null,
      indexing: false,
      error: null,
      status: 'choosing',
      session: null,
      services: null,
    })
  }

  async forgetRecent(root: string): Promise<void> {
    const { graph } = this.#state
    try {
      await this.#deps.ipc.call('forget_recent', { root }, voidSchema)
      await this.loadRecents()
      if (graph?.root === root) {
        await this.close()
      }
    } catch {
      // best-effort
    }
  }

  async deleteGraph(): Promise<void> {
    if (this.#deps.role !== 'main') {
      throw new Error('Deleting a graph is only available from the main window.')
    }
    const { graph } = this.#state
    if (graph === null) {
      return
    }
    const { root, generation } = graph
    // A newer open while the delete is in flight supersedes it (the Rust
    // side already refuses the stale generation): never tear down or
    // re-open the graph the user switched to.
    const seq = this.#openSeq
    try {
      // Pinned to `generation` so a delete can never race a graph switch and
      // trash the newly opened graph.
      await this.#deps.ipc.call('graph_delete', { generation }, voidSchema)
    } catch (err) {
      // The command invalidates the Rust session before touching the
      // filesystem, so a failed trash leaves the directory intact but the
      // session pin dead: re-open the graph to restore a writable session,
      // then let the caller surface the error.
      if (seq === this.#openSeq) {
        await this.openRecent(root)
      }
      throw err
    }
    for (const listener of this.#deletedListeners) {
      listener(root)
    }
    if (seq === this.#openSeq) {
      await this.close()
    }
    await this.loadRecents()
  }

  refreshIndex(): void {
    const { session } = this.#state
    // Off-main, a refresh would start a second concurrent index writer.
    if (session === null || session.indexGeneration === null || this.#deps.role !== 'main') {
      return
    }
    // The index lifecycle coalesces stacked triggers (resume + poll-end +
    // watch-failed can fire together) into a single queued rerun.
    this.#deps.indexLifecycle.refresh(session)
  }

  park(error: string | null): void {
    this.#setState({ error, status: 'choosing' })
  }

  reportError(error: string): void {
    this.#setState({ error })
  }

  adopt(info: GraphInfo, indexGeneration: number | null): void {
    this.#commitReady(info, indexGeneration)
  }

  attach(): Unlisten {
    const unlisteners = [
      this.#deps.indexLifecycle.onProgress((progress) => {
        this.#setState({ indexing: progress === 'reconciling' })
      }),
      // A structural vault change (folder created, renamed, or removed) cannot
      // be expressed as per-file events; the watcher asks for one full
      // reconcile instead, and `refresh` coalesces bursts into a single queued
      // rerun.
      this.#deps.fileChanges.subscribeReconcile(() => {
        this.refreshIndex()
      }),
      // A completed reconcile read changed files into the index without
      // per-file events; open sessions re-read so the visible note converges
      // with the index (unchanged files are no-op reads).
      this.#deps.indexLifecycle.onReconciled((event) => {
        if (event.source === 'sync') {
          this.#deps.openDocuments.reloadAll()
        }
      }),
      // External renames healed by id follow through to sessions and routes,
      // exactly as for an in-app rename (Plan 17).
      this.#deps.indexLifecycle.onMoved((from, to) => {
        this.#deps.noteMove.followHealedMove(from, to)
      }),
      // iCloud-evicted notes whose content the index lacks: request exactly
      // those downloads; the materialized files index via ordinary watcher
      // upserts. Rust resolves against the active root itself.
      this.#deps.indexLifecycle.onStalePlaceholders(this.#requestDownloads),
      this.#deps.indexLifecycle.followActivity(),
    ]
    return () => {
      for (const unlisten of unlisteners) {
        unlisten()
      }
    }
  }
}

export function createGraphSessionService<Services = unknown>(
  deps: GraphSessionServiceDeps<Services>,
): GraphSessionService<Services> {
  return new GraphSessionServiceImpl(deps)
}
