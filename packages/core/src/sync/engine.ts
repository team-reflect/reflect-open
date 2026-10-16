import type { ClockService, TimerHandle } from '../ports/clock-service.ts'
import { isAppError } from '../errors.ts'
import type {
  ChangedFile,
  GitCredential,
  GitRepositoryService,
  SkippedFile,
} from './git-repository-service.ts'

/**
 * The sync engine (Plan 12): debounced commit→push on edit, pull/merge/retry
 * on divergence, every failure mapped to a product state. Git mechanics never
 * reach the UI — only {@link SyncStatus}.
 *
 * Invariants:
 * - **Never wedged.** Merges commit merged text, and a binary conflict leaves
 *   a review copy beside the file, so a conflict pauses nothing.
 * - **No write loops, no idle network.** Pull-applied file changes re-enter
 *   `noteChanged` via the watcher, but the next cycle finds nothing committed
 *   and nothing ahead and ends without touching the network.
 * - **Single flight.** One cycle at a time; work requested mid-cycle runs as
 *   one follow-up afterwards, keeping the strongest mode requested.
 * - **Stop is immediate.** `stop()` aborts the engine's signal: no further
 *   status emissions, and an in-flight cycle unwinds at its next step
 *   boundary (the one git command already issued completes; nothing further
 *   runs — teardown/disconnect must not keep pushing with a stale sign-in).
 */

/**
 * Why an `error` status happened, which drives the UI affordance:
 * `auth` = credential rejected or refresh lapsed (offer reconnect);
 * `rejected` = the remote refused the push for a non-divergence reason, e.g.
 * push protection (show the message — retrying won't help until the user
 * acts); `other` = anything else (retried implicitly on the next cycle).
 */
export type SyncErrorKind = 'auth' | 'rejected' | 'other'

/**
 * The product states, as a discriminated union — `{ state: 'idle',
 * errorKind: … }` is unrepresentable. `offline` means the remote was
 * unreachable; changes stay committed locally and the next cycle (online
 * event, focus, or edit) retries.
 */
export type SyncStatus =
  | { state: 'idle' }
  | { state: 'syncing' }
  | { state: 'offline'; message: string }
  | { state: 'error'; errorKind: SyncErrorKind; message: string }

/**
 * Narrows to the `error` arm — the one state that needs user attention.
 */
export function isSyncError(status: SyncStatus): status is Extract<SyncStatus, { state: 'error' }> {
  return status.state === 'error'
}

export interface SyncEngineOptions {
  /**
   * The open graph's generation (see `root_for_generation` on the Rust
   * side): every git command this engine issues is pinned to it, so a
   * command that lands after the user switches graphs fails instead of
   * touching the wrong repository. The engine never refreshes it — the
   * owner (the backup service) builds a new engine per graph session.
   */
  generation: number
  /**
   * Resolves the HTTPS sign-in for this cycle; `null` = none (the Rust layer
   * then resolves credentials locally, e.g. the SSH agent).
   */
  getCredential: () => Promise<GitCredential | null>
  /**
   * Observes every product-state transition. Called synchronously; never
   * called again after `stop()`.
   */
  onStatus?: (status: SyncStatus) => void
  /**
   * Surfaced when the size guardrail withholds files from backup.
   */
  onLargeFilesSkipped?: (files: SkippedFile[]) => void
  /**
   * Files a pull's merge changed on disk. The caller reindexes them directly:
   * pull-applied writes must reach the index even when the file watcher isn't
   * up yet (the launch pull can race the watcher start). Invoked synchronously
   * at the merge boundary so immediate notifications cannot lag a later merge;
   * any returned promise runs alongside required Git convergence and push. A
   * successful cycle waits for every returned task before reporting idle. A
   * throw or rejection surfaces as an `error` only after that Git work has had
   * its chance to make the Markdown source of truth durable.
   */
  onRemoteChanges?: (changes: ChangedFile[]) => void | Promise<void>
  /**
   * Quiet period after the last edit before a backup commit.
   */
  idleMs?: number
  /**
   * Ceiling on deferral while the user keeps typing.
   */
  maxWaitMs?: number
  /**
   * Checked before a new cycle and again after every awaited command boundary.
   * Returning false at admission drops the trigger without issuing Git work;
   * returning false mid-cycle lets the already-issued command finish but
   * suppresses every subsequent command. The lifecycle owner must replay a
   * full cycle when work is allowed again.
   */
  canStartCycle?: () => boolean
  /**
   * Commit-only mode, for a graph with no remote (local history): every
   * cycle ends after the commit — no credential resolved, no fetch/merge,
   * no push. Edits still land in Git history and stay revertable.
   */
  localOnly?: boolean
}

export interface SyncEngine {
  /**
   * Mark the graph dirty (watcher file-change event); debounced.
   */
  noteChanged(): void
  /**
   * Full cycle now — commit, pull/merge, push. For launch/focus/manual.
   */
  syncNow(): Promise<void>
  /**
   * Commit now, nothing more: the quit-time and background flush. Joins the
   * single-flight queue like every other cycle, so it can never run between
   * a pull's steps; a network push on the way out could stall the exit.
   */
  commitNow(): Promise<void>
  /**
   * Abort the engine: cancel timers, suppress further status emissions, and
   * unwind any in-flight cycle at its next step boundary.
   */
  stop(): void
}

const DEFAULT_IDLE_MS = 30_000
const DEFAULT_MAX_WAIT_MS = 5 * 60_000

/**
 * Push attempts per cycle. Each retry fetches + merges first, so two devices
 * racing converge fast; a remote advancing faster than we can merge for three
 * straight rounds is pathological enough to surface.
 */
const MAX_PUSH_ATTEMPTS = 3

/**
 * What a cycle does after its commit. The debounce asks for `network` only
 * (push if anything is pending); launch, focus, and manual syncs add
 * `fetch` (pull and merge first); the quit and background flush ask for
 * neither and stop at the commit. A follow-up requested mid-cycle is the
 * union of what was asked.
 */
interface CycleRequest {
  readonly fetch: boolean
  readonly network: boolean
}
const COMMIT: CycleRequest = { fetch: false, network: false }
const PUSH: CycleRequest = { fetch: false, network: true }
const FULL: CycleRequest = { fetch: true, network: true }

/**
 * A push the remote refused for a non-divergence reason (e.g. push protection).
 */
class PushRejectedError extends Error {}

/**
 * Internal control flow: the owner suspended cycles while one command was in flight.
 */
class CycleSuppressedError extends Error {}

/**
 * Builds the {@link SyncEngine} of one graph session.
 */
export interface SyncEngineFactory {
  /**
   * Build a sync engine for one graph session. The engine starts idle and does
   * nothing until `noteChanged()` (debounced commit→push) or `syncNow()` (full
   * commit→pull/merge→push) is called; all output flows through the
   * {@link SyncEngineOptions} callbacks. `stop()` is terminal — build a new
   * engine to resume.
   */
  create(options: SyncEngineOptions): SyncEngine
}

/**
 * What a {@link SyncEngine} runs on.
 */
export interface SyncEngineDeps {
  readonly git: GitRepositoryService
  readonly clock: ClockService
}

class SyncEngineImpl implements SyncEngine {
  readonly #deps: SyncEngineDeps
  readonly #options: SyncEngineOptions
  readonly #idleMs: number
  readonly #maxWaitMs: number
  readonly #abort = new AbortController()
  readonly #signal = this.#abort.signal
  #timer: TimerHandle | null = null
  /**
   * Hard deadline (first unflushed edit + maxWaitMs); null = nothing pending.
   */
  #deadline: number | null = null
  #running: Promise<void> | null = null
  /**
   * The one follow-up requested while a cycle was in flight (the union of
   * every request). Its callers await `done`, which settles when the
   * follow-up itself finishes, not when the cycle they landed behind does:
   * the quit flush must not report done before its own commit ran. `flush`
   * remembers that a commit-only request joined: a network follow-up the
   * owner gates in the meantime still owes that commit.
   */
  #followUp: {
    request: CycleRequest
    flush: boolean
    done: Promise<void>
    settle: () => void
  } | null = null
  /**
   * Set by an auth failure, cleared by the next resume trigger (`syncNow`:
   * launch, focus, online, manual) or by a cycle that gets through. While
   * set, edit-triggered cycles still commit locally but skip the network:
   * retrying per edit would repeat the same failure, and for a GitHub remote
   * the same reconnect prompt, with nothing having changed in between.
   */
  #authFailed = false

  constructor(deps: SyncEngineDeps, options: SyncEngineOptions) {
    this.#deps = deps
    this.#options = options
    this.#idleMs = options.idleMs ?? DEFAULT_IDLE_MS
    this.#maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
  }

  noteChanged(): void {
    if (this.#signal.aborted) {
      return
    }
    const now = this.#deps.clock.now()
    if (this.#deadline === null) {
      this.#deadline = now + this.#maxWaitMs
    }
    // Wait for the idle window, but never past the deadline — a continuously
    // edited graph still backs up at least every maxWaitMs.
    this.#schedule(Math.max(0, Math.min(this.#idleMs, this.#deadline - now)))
  }

  syncNow(): Promise<void> {
    this.#authFailed = false // a resume trigger: the user may have fixed the sign-in
    return this.#run(FULL)
  }

  commitNow(): Promise<void> {
    return this.#run(COMMIT)
  }

  stop(): void {
    this.#abort.abort()
    if (this.#timer !== null) {
      this.#deps.clock.clearTimeout(this.#timer)
      this.#timer = null
    }
  }

  #emit(status: SyncStatus): void {
    if (this.#signal.aborted) {
      return // a stopped engine must not resurrect UI state (e.g. post-disconnect)
    }
    this.#options.onStatus?.(status)
  }

  /**
   * Await one cycle step, preserve any result-side notification, then bail if
   * the engine stopped or the owner suppressed further cycles meanwhile. An
   * already-issued Git command cannot be recalled, but no later command starts.
   */
  async #step<T>(promise: Promise<T>, onResult?: (result: T) => void): Promise<T> {
    const result = await promise
    this.#signal.throwIfAborted()
    onResult?.(result)
    // A synchronous result notification can itself tear down the owner (for
    // example, a file-change subscriber closing the graph). Preserve stop's
    // command boundary before the caller is allowed to issue later Git work.
    this.#signal.throwIfAborted()
    if (this.#options.canStartCycle?.() === false) {
      throw new CycleSuppressedError()
    }
    return result
  }

  /** Start one merge notification now, without making later Git commands wait. */
  #startRemoteChanges(changes: ChangedFile[]): Promise<void> {
    let task: Promise<void>
    try {
      task = Promise.resolve(this.#options.onRemoteChanges?.(changes))
    } catch (error) {
      task = Promise.reject(error)
    }
    // Attach a handler immediately: a synchronous throw or fast rejection can
    // happen well before the successful cycle joins this task at its idle
    // boundary, and must never become an unhandled rejection in between.
    void task.catch(() => {})
    return task
  }

  /** Join this cycle's observer tasks and rethrow the first error. */
  async #settleRemoteChanges(
    tasks: readonly Promise<void>[],
    checkSuppression = true,
  ): Promise<void> {
    if (tasks.length === 0) {
      return
    }
    const outcomes = await Promise.allSettled(tasks)
    this.#signal.throwIfAborted()
    const failed = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    )
    if (failed !== undefined) {
      throw failed.reason
    }
    if (checkSuppression && this.#options.canStartCycle?.() === false) {
      throw new CycleSuppressedError()
    }
  }

  #schedule(delayMs: number): void {
    if (this.#timer !== null) {
      this.#deps.clock.clearTimeout(this.#timer)
    }
    this.#timer = this.#deps.clock.setTimeout(() => {
      this.#timer = null
      void this.#run(PUSH)
    }, delayMs)
  }

  async #run(request: CycleRequest): Promise<void> {
    // A commit-only cycle is the background/quit flush: it must run while the
    // document is hidden (that is when it fires), so only network cycles
    // honor the owner's gate.
    if (this.#signal.aborted || (request.network && this.#options.canStartCycle?.() === false)) {
      return
    }
    if (this.#running !== null) {
      // Queue one follow-up that does everything asked of it: a syncNow
      // landing mid-cycle must still get its fetch+merge, not be downgraded
      // to a push-only pass.
      if (this.#followUp === null) {
        let settle = (): void => {}
        const done = new Promise<void>((resolve) => {
          settle = resolve
        })
        this.#followUp = { request, flush: !request.network, done, settle }
      } else {
        const queued = this.#followUp.request
        this.#followUp.request = {
          fetch: queued.fetch || request.fetch,
          network: queued.network || request.network,
        }
        this.#followUp.flush ||= !request.network
      }
      return await this.#followUp.done
    }
    this.#running = (async () => {
      const quiet = !request.fetch && this.#authFailed
      const remoteChangeTasks: Promise<void>[] = []
      // This cycle commits everything dirty so far — a pending debounce pass
      // (e.g. queued before a launch/focus/manual sync) would only duplicate it.
      if (this.#timer !== null) {
        this.#deps.clock.clearTimeout(this.#timer)
        this.#timer = null
      }
      this.#deadline = null
      if (!quiet) {
        this.#emit({ state: 'syncing' })
      }
      try {
        await this.#cycle(request, quiet, (changes) => {
          remoteChangeTasks.push(this.#startRemoteChanges(changes))
        })
        await this.#settleRemoteChanges(remoteChangeTasks)
        if (!quiet) {
          this.#authFailed = false
          this.#emit({ state: 'idle' })
        }
      } catch (error) {
        if (error instanceof CycleSuppressedError) {
          // A merge can land and queue its changed files just before the owner
          // suppresses later Git commands. Preserve the old boundary: finish
          // that notification before the suppressed cycle settles to idle.
          try {
            await this.#settleRemoteChanges(remoteChangeTasks, false)
            this.#emit({ state: 'idle' })
          } catch (notificationError) {
            if (!this.#signal.aborted) {
              this.#emit(statusForError(notificationError))
            }
          }
        } else if (!this.#signal.aborted) {
          const status = statusForError(error)
          this.#authFailed = status.state === 'error' && status.errorKind === 'auth'
          this.#emit(status)
        }
      } finally {
        this.#running = null
        if (this.#followUp !== null) {
          const next = this.#followUp
          this.#followUp = null
          // A stopped engine runs nothing more, but its awaiters must not hang.
          // A gated network follow-up still runs the commit a flush asked for.
          const gated = this.#options.canStartCycle?.() === false
          const request = gated && next.flush ? COMMIT : next.request
          void (this.#signal.aborted ? Promise.resolve() : this.#run(request)).finally(next.settle)
        }
      }
    })()
    return await this.#running
  }

  async #cycle(
    request: CycleRequest,
    quiet: boolean,
    remoteChanges: (changes: ChangedFile[]) => void,
  ): Promise<void> {
    if (!request.network) {
      // One command, no gate: the flush's commit must finish even hidden.
      const flushed = await this.#deps.git.commitAll('Update notes', this.#options.generation)
      this.#signal.throwIfAborted()
      if (flushed.skippedLargeFiles.length > 0) {
        this.#options.onLargeFilesSkipped?.(flushed.skippedLargeFiles)
      }
      return
    }
    const offline = this.#options.localOnly === true || quiet
    // The commit comes first: it is the part of every cycle a flush is owed,
    // and it must land even if the owner gates the network work that follows
    // (the credential resolution is the first point a gate can interrupt).
    const commit = await this.#step(
      this.#deps.git.commitAll('Update notes', this.#options.generation),
    )
    if (commit.skippedLargeFiles.length > 0) {
      this.#options.onLargeFilesSkipped?.(commit.skippedLargeFiles)
    }
    if (offline) {
      return // the commit is the whole cycle: no remote, or the sign-in is known bad
    }
    const credential = await this.#step(this.#options.getCredential())
    if (!request.fetch) {
      // The debounce path often fires for changes that are already committed
      // and pushed (a pull's own writes re-enter via the watcher). Nothing
      // committed and nothing ahead means a push would be a pointless network
      // negotiation — end the cycle without one.
      if (!commit.committed && commit.ahead === 0) {
        return
      }
    } else {
      // Launch/focus: pick up other devices' changes even with nothing to push.
      const delta = await this.#step(this.#deps.git.fetch(credential, this.#options.generation))
      const merged = await this.#merge(remoteChanges)
      const localOnly = commit.committed || delta.ahead > 0
      if (!localOnly && (merged.kind === 'upToDate' || merged.kind === 'fastForward')) {
        return // pulled cleanly and have nothing of our own — no push needed
      }
    }
    for (let attempt = 0; attempt < MAX_PUSH_ATTEMPTS; attempt++) {
      const push = await this.#step(this.#deps.git.push(credential, this.#options.generation))
      if (push.pushed) {
        return
      }
      if (!push.nonFastForward) {
        throw new PushRejectedError(push.rejectionMessage ?? 'the remote rejected the backup')
      }
      // The normal two-device race: another device pushed first. Converge and
      // retry — a conflicted merge still commits (markers in the note).
      await this.#step(this.#deps.git.fetch(credential, this.#options.generation))
      await this.#merge(remoteChanges)
    }
    throw new PushRejectedError(
      'the backup repo kept changing while syncing; will retry on the next edit',
    )
  }

  /** Merge fetched changes and start any changed-file notification. */
  async #merge(remoteChanges: (changes: ChangedFile[]) => void): Promise<{ kind: string }> {
    return await this.#step(this.#deps.git.mergeRemote(this.#options.generation), (outcome) => {
      // The command may already have rewritten files before suspension. Fan
      // those changes out before the boundary gate stops subsequent Git work.
      if (outcome.changedFiles.length > 0) {
        remoteChanges(outcome.changedFiles)
      }
    }) // upToDate is a no-op
  }
}

export function createSyncEngineFactory(deps: SyncEngineDeps): SyncEngineFactory {
  return { create: (options) => new SyncEngineImpl(deps, options) }
}

function statusForError(error: unknown): SyncStatus {
  if (error instanceof PushRejectedError) {
    return { state: 'error', errorKind: 'rejected', message: error.message }
  }
  if (isAppError(error)) {
    if (error.kind === 'network') {
      return {
        state: 'offline',
        message: 'Offline — changes are saved locally and will back up when you reconnect',
      }
    }
    if (error.kind === 'auth') {
      return { state: 'error', errorKind: 'auth', message: error.message }
    }
    return { state: 'error', errorKind: 'other', message: error.message }
  }
  return {
    state: 'error',
    errorKind: 'other',
    message: error instanceof Error ? error.message : String(error),
  }
}
