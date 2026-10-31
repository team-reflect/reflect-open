import { z } from 'zod'
import type { ClockService } from '../ports/clock-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import { errorMessage } from '../errors.ts'
import type { FileChangeService } from '../indexing/file-change-service.ts'
import { listenNow, type IpcBridgeService } from '../ipc/ipc-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type { GraphSessionService } from './graph-session-service.ts'
import {
  graphImportProgressSchema,
  graphImportSummarySchema,
  type GraphImportProgress,
  type GraphImportSummary,
} from './schemas.ts'

/**
 * Commands that return `()` from Rust serialize as `null` over IPC.
 */
const voidSchema = z.null()

/**
 * Event name the running import emits {@link GraphImportProgress} ticks on.
 */
export const IMPORT_PROGRESS_EVENT = 'import:progress'

/**
 * Where the Reflect V1 import stands. `running.progress` is null until the
 * first native progress tick (the zip is being read); `cancelling` means the
 * user asked to stop and the native side is winding down.
 */
export type V1ImportState =
  | { phase: 'idle' }
  | { phase: 'running'; progress: GraphImportProgress | null; cancelling: boolean }
  | { phase: 'done'; summary: GraphImportSummary }
  | { phase: 'failed'; message: string }

/**
 * The Reflect V1 import of one graph workspace. V1 exports already use
 * Reflect Open's graph-folder layout; Rust extracts safe entries under the
 * active graph root without ever replacing an existing file (identical files
 * skip, conflicting notes rename, conflicting daily notes merge). Attachments
 * the notes link to on Firebase Storage or Reflect's asset CDN are downloaded
 * into `assets/` and the links rewritten, so an import can take a while on
 * attachment-heavy graphs. Members are function properties so surfaces can
 * pass them around unbound.
 */
export interface V1ImportService {
  getState: () => V1ImportState
  subscribe: (listener: () => void) => Unlisten
  /**
   * Kick off an import of the chosen `.zip`; ignored while one runs and while no graph is open.
   */
  start(zipPath: string): void
  /**
   * Ask the running import to stop. The import aborts before anything lands
   * in the graph, so cancelling is always safe.
   */
  cancel(): void
  /**
   * Clear a finished (done/failed) import back to idle.
   */
  dismiss(): void
  /**
   * The workspace that shows this import is up. The returned function tells
   * the service it went away: a running import is cancelled and its result
   * dropped.
   */
  attach(): Unlisten
}

export interface V1ImportServiceDeps {
  readonly ipc: IpcBridgeService
  readonly fileChanges: FileChangeService
  readonly graphSession: GraphSessionService
  readonly clock: ClockService
  readonly logger: LoggerService
}

class V1ImportServiceImpl implements V1ImportService {
  readonly #deps: V1ImportServiceDeps
  readonly #listeners = new Set<() => void>()
  #state: V1ImportState = { phase: 'idle' }
  #running = false
  #cancelRequested = false
  // The native import keeps running without its workspace; if the workspace
  // goes away mid-import (graph switch, app teardown) nobody is left to show
  // or apply the result, so stop the work too. `attached` also gates the
  // completion bookkeeping: cancellation only aborts before the write phase,
  // so a near-finished import can still resolve after the workspace left —
  // its own-write echoes and index refresh would then land on whatever graph
  // is open now, not the one it imported into.
  #attached = true

  constructor(deps: V1ImportServiceDeps) {
    this.#deps = deps
  }

  readonly getState = (): V1ImportState => this.#state

  readonly subscribe = (listener: () => void): Unlisten => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  start(zipPath: string): void {
    const { ipc, graphSession } = this.#deps
    const startedFor = graphSession.getState().graph
    if (this.#running || startedFor === null) {
      return
    }
    this.#running = true
    this.#cancelRequested = false
    this.#setState({ phase: 'running', progress: null, cancelling: false })
    const unlisten = this.#subscribeProgress((progress) => {
      if (this.#state.phase === 'running') {
        this.#setState({ ...this.#state, progress })
      }
    })
    void (async () => {
      try {
        const summary = await ipc.call(
          'graph_import_reflect_v1_zip',
          { path: zipPath, generation: startedFor.generation },
          graphImportSummarySchema,
        )
        const current = graphSession.getState().graph
        if (
          this.#attached &&
          current !== null &&
          current.root === startedFor.root &&
          current.generation === startedFor.generation
        ) {
          this.#markOwnWrites(summary)
          graphSession.refreshIndex()
          this.#setState({ phase: 'done', summary })
        } else {
          this.#setState({ phase: 'idle' })
        }
      } catch (caught: unknown) {
        // A rejection after the user hit Cancel is the cancellation itself,
        // not a failure worth surfacing.
        this.#setState(
          this.#cancelRequested
            ? { phase: 'idle' }
            : { phase: 'failed', message: errorMessage(caught) },
        )
      } finally {
        this.#running = false
        unlisten()
      }
    })()
  }

  cancel(): void {
    if (!this.#running || this.#cancelRequested) {
      return
    }
    this.#cancelRequested = true
    if (this.#state.phase === 'running') {
      this.#setState({ ...this.#state, cancelling: true })
    }
    void this.#cancelNative().catch(() => {})
  }

  dismiss(): void {
    if (this.#state.phase !== 'running') {
      this.#setState({ phase: 'idle' })
    }
  }

  attach(): Unlisten {
    this.#attached = true
    return () => {
      this.#attached = false
      if (this.#running) {
        void this.#cancelNative().catch(() => {})
      }
    }
  }

  #setState(next: V1ImportState): void {
    if (next === this.#state) {
      return
    }
    this.#state = next
    for (const listener of this.#listeners) {
      listener()
    }
  }

  /**
   * Live progress ticks of the running import.
   */
  #subscribeProgress(handler: (progress: GraphImportProgress) => void): Unlisten {
    const { ipc, logger } = this.#deps
    return listenNow(
      () => {
        return ipc.listen(IMPORT_PROGRESS_EVENT, (payload) => {
          const parsed = graphImportProgressSchema.safeParse(payload)
          if (parsed.success) {
            handler(parsed.data)
          } else {
            logger.error('invalid import:progress payload:', parsed.error)
          }
        })
      },
      (cause) => {
        logger.warn(`failed to listen for "${IMPORT_PROGRESS_EVENT}"`, cause)
      },
    )
  }

  /**
   * Cancel the running import (a no-op when none runs); the pending import call rejects.
   */
  async #cancelNative(): Promise<void> {
    await this.#deps.ipc.call('graph_import_cancel', {}, voidSchema)
  }

  /**
   * Mark the imported files as this device's writes. Only after the imported
   * graph is confirmed to be the active graph still: these paths are
   * graph-relative and the own-write channel is scoped to the currently
   * running iCloud controller.
   */
  #markOwnWrites(summary: GraphImportSummary): void {
    const { clock, fileChanges } = this.#deps
    const modifiedMs = clock.now()
    for (const changedPath of summary.changedPaths) {
      fileChanges.reportOwnWrite([{ path: changedPath, kind: 'upsert', modifiedMs }])
    }
  }
}

export function createV1ImportService(deps: V1ImportServiceDeps): V1ImportService {
  return new V1ImportServiceImpl(deps)
}
