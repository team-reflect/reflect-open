import type { ClockService, TimerHandle } from '../ports/clock-service.ts'
import { isAppError } from '../errors.ts'
import type {
  ChangedFile,
  GitCredential,
  GitRepositoryService,
  PullOutcome,
  SkippedFile,
} from './git-repository-service.ts'

/**
 * The sync engine: debounced commit→push on edit, fetch→pull→push with retry
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
 * event, focus, or edit) retries. `waiting` is quiet mode between a local
 * commit and the network pass; `until` is the epoch ms when the quiet window
 * ends.
 */
export type SyncStatus =
  | { state: 'idle' }
  | { state: 'syncing' }
  | { state: 'waiting'; until: number }
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
  onStatus?: ((status: SyncStatus) => void) | undefined
  /**
   * Surfaced when the size guardrail withholds files from backup.
   */
  onLargeFilesSkipped?: ((files: SkippedFile[]) => void) | undefined
  /**
   * Files a pull's merge changed on disk. The caller reindexes them directly,
   * because the file watcher may not be up yet. Invoked synchronously at the
   * merge boundary. A returned promise runs alongside the push; the cycle
   * waits for it before reporting idle, and a failure surfaces as `error`
   * after that Git work.
   */
  onRemoteChanges?: ((changes: ChangedFile[]) => void | Promise<void>) | undefined
  /**
   * Paths a pull kept for review beside their notes. Called synchronously.
   */
  onReview?: ((paths: string[]) => void) | undefined
  /**
   * Quiet period after the last edit before a backup commit.
   */
  idleMs?: number | undefined
  /**
   * Ceiling on deferral while the user keeps typing.
   */
  maxWaitMs?: number | undefined
  /**
   * Checked before a new cycle and again after every awaited command boundary.
   * Returning false at admission drops the trigger without issuing Git work;
   * returning false mid-cycle lets the already-issued command finish but
   * suppresses every subsequent command, except the commit, credential, and
   * push of a push-only cycle and the push of a full cycle (they only send
   * what is already committed). A full cycle that owes a flush commit and is
   * stopped before its pull commits once. The owner must replay a full cycle
   * when work is allowed again.
   */
  canStartCycle?: (() => boolean) | undefined
  /**
   * Commit-only mode, for a graph with no remote: every cycle ends after
   * the commit (no credential, fetch, pull, or push).
   */
  localOnly?: boolean | undefined
  /**
   * Quiet mode: edits and manual syncs only commit locally. The network pass
   * runs once this many ms pass with no edit and no pulled change, and only
   * when {@link networkReady} agrees.
   */
  quietMs?: number | undefined
  /**
   * Asked when the quiet window ends. False postpones the network pass,
   * with a growing delay up to five minutes.
   */
  networkReady?: (() => Promise<boolean>) | undefined
}

export interface SyncEngine {
  /**
   * Mark the graph dirty (watcher file-change event); debounced.
   */
  noteChanged(): void
  /**
   * Full cycle now: fetch, pull (commit and merge), push. For launch/focus/manual.
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
const QUIET_BACKOFF_START_MS = 30_000
const QUIET_BACKOFF_MAX_MS = 5 * 60_000

/**
 * Push attempts per cycle. Each retry fetches + pulls first, so two devices
 * racing converge fast; a remote advancing faster than we can merge for three
 * straight rounds is pathological enough to surface.
 */
const MAX_PUSH_ATTEMPTS = 3

/**
 * What a cycle does. The debounce asks for `network` only (commit, then
 * push if anything is pending). Launch, focus, and manual syncs add `fetch`
 * (fetch, pull, push). The quit and background flush ask for neither and
 * stop at the commit. A follow-up requested mid-cycle is the union of the
 * requests.
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
   * nothing until `noteChanged()` or `syncNow()` is called. All output flows
   * through the {@link SyncEngineOptions} callbacks. `stop()` is terminal.
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
  readonly #quietMs: number | null
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
  #quietTimer: TimerHandle | null = null
  /** Bumped by every arm, so a stale `networkReady` answer is ignored. */
  #quietGeneration = 0
  #quietUntil = 0
  /** True from a quiet window's expiry until its network pass ends. */
  #quietBusy = false
  #current: SyncStatus = { state: 'idle' }

  constructor(deps: SyncEngineDeps, options: SyncEngineOptions) {
    this.#deps = deps
    this.#options = options
    this.#idleMs = options.idleMs ?? DEFAULT_IDLE_MS
    this.#maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
    this.#quietMs = options.quietMs ?? null
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
    // An edit invalidates an open window and any readiness answer already requested.
    if (this.#quietMs !== null && (this.#quietTimer !== null || this.#quietBusy)) {
      this.#armQuiet(this.#quietMs)
    }
  }

  syncNow(): Promise<void> {
    this.#authFailed = false // a resume trigger: the user may have fixed the sign-in
    if (this.#quietMs !== null) {
      if (this.#quietTimer === null && !this.#quietBusy) {
        this.#armQuiet(this.#quietMs)
      }
      return this.#run(COMMIT)
    }
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
    if (this.#quietTimer !== null) {
      this.#deps.clock.clearTimeout(this.#quietTimer)
      this.#quietTimer = null
    }
  }

  #emit(status: SyncStatus): void {
    if (this.#signal.aborted) {
      return // a stopped engine must not resurrect UI state (e.g. post-disconnect)
    }
    this.#current = status
    this.#options.onStatus?.(status)
  }

  /** Report the end of a cycle: `waiting` while a quiet window is open, else `idle`. */
  #emitSettled(): void {
    this.#emit(
      this.#quietTimer === null ? { state: 'idle' } : { state: 'waiting', until: this.#quietUntil },
    )
  }

  /** Open a fresh quiet window, replacing any window that is open. */
  #armQuiet(delayMs: number, nextBackoffMs = QUIET_BACKOFF_START_MS): void {
    if (this.#signal.aborted) {
      return
    }
    if (this.#quietTimer !== null) {
      this.#deps.clock.clearTimeout(this.#quietTimer)
    }
    const generation = ++this.#quietGeneration
    this.#quietUntil = this.#deps.clock.now() + delayMs
    this.#quietTimer = this.#deps.clock.setTimeout(() => {
      this.#quietTimer = null
      void this.#afterQuiet(generation, nextBackoffMs)
    }, delayMs)
    // Keep an error visible, and leave a running cycle to report its own end.
    if (this.#current.state !== 'error' && this.#running === null) {
      this.#emit({ state: 'waiting', until: this.#quietUntil })
    }
  }

  async #afterQuiet(generation: number, nextBackoffMs: number): Promise<void> {
    if (generation !== this.#quietGeneration || this.#signal.aborted) {
      return
    }
    this.#quietBusy = true
    try {
      await this.#quietPass(generation, nextBackoffMs)
    } finally {
      this.#quietBusy = false
    }
  }

  async #quietPass(generation: number, backoffMs: number): Promise<void> {
    // A rejected sign-in stays rejected until a resume trigger clears it.
    if (this.#authFailed) {
      return
    }
    let ready: boolean
    try {
      ready = (await this.#options.networkReady?.()) ?? true
    } catch {
      ready = false
    }
    if (generation !== this.#quietGeneration || this.#signal.aborted) {
      return
    }
    if (ready) {
      await this.#run(FULL)
      return
    }
    this.#armQuiet(backoffMs, Math.min(backoffMs * 2, QUIET_BACKOFF_MAX_MS))
  }

  /**
   * Await one cycle step, preserve any result-side notification, then bail if
   * the engine stopped or the owner suppressed further cycles meanwhile. An
   * already-issued Git command cannot be recalled, but no later command starts.
   */
  async #step<T>(
    promise: Promise<T>,
    { gated = true, onResult }: { gated?: boolean; onResult?: (result: T) => void } = {},
  ): Promise<T> {
    const result = await promise
    this.#signal.throwIfAborted()
    onResult?.(result)
    // onResult can tear down the owner (e.g. close the graph): re-check.
    this.#signal.throwIfAborted()
    if (gated && this.#options.canStartCycle?.() === false) {
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
    // Attach a handler now so an early rejection is never unhandled.
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
      const quietMs = this.#quietMs
      if (quietMs === null) {
        void this.#run(PUSH)
        return
      }
      void this.#run(COMMIT).then(() => {
        this.#armQuiet(quietMs)
      })
    }, delayMs)
  }

  async #run(request: CycleRequest, owesCommit = false): Promise<void> {
    // A commit-only cycle is the background/quit flush: it must run while the
    // document is hidden (that is when it fires), so only network cycles
    // honor the owner's gate.
    if (this.#signal.aborted || (request.network && this.#options.canStartCycle?.() === false)) {
      return
    }
    if (this.#running !== null) {
      // Queue one follow-up that does the union of every request.
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
        await this.#cycle(request, quiet, owesCommit, (changes) => {
          remoteChangeTasks.push(this.#startRemoteChanges(changes))
        })
        await this.#settleRemoteChanges(remoteChangeTasks)
        if (!quiet) {
          this.#authFailed = false
          this.#emitSettled()
        }
      } catch (error) {
        if (error instanceof CycleSuppressedError) {
          // A merge can land just before the owner suppresses later Git
          // commands: finish its notification before settling.
          try {
            await this.#settleRemoteChanges(remoteChangeTasks, false)
            this.#emitSettled()
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
          void (this.#signal.aborted ? Promise.resolve() : this.#run(request, next.flush)).finally(
            next.settle,
          )
        }
      }
    })()
    return await this.#running
  }

  async #cycle(
    request: CycleRequest,
    quiet: boolean,
    owesCommit: boolean,
    remoteChanges: (changes: ChangedFile[]) => void,
  ): Promise<void> {
    if (!request.network) {
      // One command, no gate: the flush's commit must finish even hidden.
      const flushed = await this.#deps.git.commitAll('Update notes', this.#options.generation)
      this.#signal.throwIfAborted()
      this.#reportSkipped(flushed.skippedLargeFiles)
      return
    }
    const offline = this.#options.localOnly === true || quiet
    if (offline || !request.fetch) {
      // The commit lands even if the owner gates the network work after it.
      const commit = await this.#step(
        this.#deps.git.commitAll('Update notes', this.#options.generation),
        { gated: false, onResult: (outcome) => this.#reportSkipped(outcome.skippedLargeFiles) },
      )
      if (offline) {
        return // the commit is the whole cycle: no remote, or the sign-in is known bad
      }
      const credential = await this.#step(this.#options.getCredential(), { gated: false })
      // A pull's own writes re-enter via the watcher: nothing to push.
      if (!commit.committed && commit.ahead === 0) {
        return
      }
      await this.#push(credential, remoteChanges)
      return
    }
    let pullStarted = false
    try {
      const credential = await this.#step(this.#options.getCredential())
      await this.#step(this.#deps.git.fetch(credential, this.#options.generation))
      pullStarted = true
      const pull = await this.#pull(remoteChanges)
      if (!pull.committed && pull.ahead === 0) {
        return // pulled cleanly and have nothing of our own — no push needed
      }
      await this.#push(credential, remoteChanges)
    } catch (error) {
      // A cycle that ends before its pull still commits local edits, unless
      // the gate closed and no flush is owed.
      const owed = error instanceof CycleSuppressedError ? owesCommit : true
      if (!pullStarted && owed && !this.#signal.aborted) {
        const outcome = await this.#deps.git.commitAll('Update notes', this.#options.generation)
        this.#reportSkipped(outcome.skippedLargeFiles)
      }
      throw error
    }
  }

  async #push(
    credential: GitCredential | null,
    remoteChanges: (changes: ChangedFile[]) => void,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_PUSH_ATTEMPTS; attempt++) {
      const push = await this.#step(this.#deps.git.push(credential, this.#options.generation), {
        gated: false,
      })
      if (push.pushed) {
        return
      }
      if (!push.nonFastForward) {
        throw new PushRejectedError(push.rejectionMessage ?? 'the remote rejected the backup')
      }
      // Another device pushed first: pull, then retry.
      await this.#step(this.#deps.git.fetch(credential, this.#options.generation))
      await this.#pull(remoteChanges)
    }
    throw new PushRejectedError(
      'the backup repo kept changing while syncing; will retry on the next edit',
    )
  }

  #reportSkipped(files: SkippedFile[]): void {
    if (files.length > 0) {
      this.#options.onLargeFilesSkipped?.(files)
    }
  }

  /** Commit and merge fetched changes, and start any changed-file notification. */
  async #pull(remoteChanges: (changes: ChangedFile[]) => void): Promise<PullOutcome> {
    return await this.#step(this.#deps.git.pull('Update notes', this.#options.generation), {
      onResult: (outcome) => {
        this.#reportSkipped(outcome.skippedLargeFiles)
        // The command may have rewritten files before the gate closes: report them first.
        if (outcome.changedFiles.length > 0) {
          remoteChanges(outcome.changedFiles)
          if (this.#quietMs !== null) {
            this.#armQuiet(this.#quietMs)
          }
        }
        if (outcome.reviewPaths.length > 0) {
          this.#options.onReview?.(outcome.reviewPaths)
        }
      },
    })
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
