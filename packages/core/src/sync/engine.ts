import { isAppError } from '../errors'
import {
  gitCommitAll,
  gitFetch,
  gitMergeRemote,
  gitPush,
  type ChangedFile,
  type SkippedFile,
} from './commands'

/**
 * The sync engine (Plan 12): debounced commit→push on edit, pull/merge/retry
 * on divergence, every failure mapped to a product state. Git mechanics never
 * reach the UI — only {@link SyncStatus}.
 *
 * Invariants:
 * - **Never wedged.** Merges commit their conflicts (markers in the note), so
 *   a conflict pauses nothing; the indexer surfaces `Needs review` per note.
 * - **No write loops, no idle network.** Pull-applied file changes re-enter
 *   `noteChanged` via the watcher, but the next cycle finds nothing committed
 *   and nothing ahead and ends without touching the network.
 * - **Single flight.** One cycle at a time; work requested mid-cycle runs as
 *   one follow-up afterwards, keeping the strongest mode requested.
 * - **Stop is immediate.** `stop()` aborts the engine's signal: no further
 *   status emissions, and an in-flight cycle unwinds at its next step
 *   boundary (the one git command already issued completes; nothing further
 *   runs — teardown/disconnect must not keep pushing with a stale token).
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

/** Narrows to the `error` arm — the one state that needs user attention. */
export function isSyncError(status: SyncStatus): status is Extract<SyncStatus, { state: 'error' }> {
  return status.state === 'error'
}

export interface SyncEngineOptions {
  /**
   * The open graph's generation (see `root_for_generation` on the Rust
   * side): every git command this engine issues is pinned to it, so a
   * command that lands after the user switches graphs fails instead of
   * touching the wrong repository. The engine never refreshes it — the
   * owner (the backup controller) builds a new engine per graph session.
   */
  generation: number
  /** Resolves the remote credential; `null` = none connected (auth error). */
  getToken: () => Promise<string | null>
  /**
   * Observes every product-state transition. Called synchronously; never
   * called again after `stop()`.
   */
  onStatus?: (status: SyncStatus) => void
  /** Surfaced when the size guardrail withholds files from backup. */
  onLargeFilesSkipped?: (files: SkippedFile[]) => void
  /**
   * Files a pull's merge changed on disk. The caller reindexes them directly:
   * pull-applied writes must reach the index even when the file watcher isn't
   * up yet (the launch pull can race the watcher start). Called synchronously
   * mid-cycle and not awaited — kick off async work, don't block on it. A
   * throw here fails the cycle and surfaces as an `error` status.
   */
  onRemoteChanges?: (changes: ChangedFile[]) => void
  /** Quiet period after the last edit before a backup commit. */
  idleMs?: number
  /** Ceiling on deferral while the user keeps typing. */
  maxWaitMs?: number
}

export interface SyncEngine {
  /** Mark the graph dirty (watcher file-change event); debounced. */
  noteChanged(): void
  /** Full cycle now — commit, pull/merge, push. For launch/focus/manual. */
  syncNow(): Promise<void>
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

/** A push the remote refused for a non-divergence reason (e.g. push protection). */
class PushRejectedError extends Error {}

/**
 * Build a sync engine for one graph session. The engine starts idle and does
 * nothing until `noteChanged()` (debounced commit→push) or `syncNow()` (full
 * commit→pull/merge→push) is called; all output flows through the
 * {@link SyncEngineOptions} callbacks. `stop()` is terminal — build a new
 * engine to resume.
 */
export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS

  const abort = new AbortController()
  const signal = abort.signal
  let timer: ReturnType<typeof setTimeout> | null = null
  /** Hard deadline (first unflushed edit + maxWaitMs); null = nothing pending. */
  let deadline: number | null = null
  let running: Promise<void> | null = null
  /** Follow-up requested while a cycle was in flight (strongest mode wins). */
  let rerunMode: 'push' | 'full' | null = null

  function emit(status: SyncStatus): void {
    if (signal.aborted) {
      return // a stopped engine must not resurrect UI state (e.g. post-disconnect)
    }
    options.onStatus?.(status)
  }

  /**
   * Await one cycle step, then bail if the engine stopped meanwhile. An
   * already-issued git command can't be recalled, but nothing further runs
   * after `stop()`.
   */
  async function step<T>(promise: Promise<T>): Promise<T> {
    const result = await promise
    signal.throwIfAborted()
    return result
  }

  function schedule(delayMs: number): void {
    if (timer !== null) {
      clearTimeout(timer)
    }
    timer = setTimeout(() => {
      timer = null
      void run('push')
    }, delayMs)
  }

  function noteChanged(): void {
    if (signal.aborted) {
      return
    }
    const now = Date.now()
    if (deadline === null) {
      deadline = now + maxWaitMs
    }
    // Wait for the idle window, but never past the deadline — a continuously
    // edited graph still backs up at least every maxWaitMs.
    schedule(Math.max(0, Math.min(idleMs, deadline - now)))
  }

  async function run(mode: 'push' | 'full'): Promise<void> {
    if (signal.aborted) {
      return
    }
    if (running !== null) {
      // Queue one follow-up, keeping the strongest mode requested: a syncNow
      // landing mid-cycle must still get its fetch+merge, not be downgraded
      // to a push-only pass.
      rerunMode = rerunMode === 'full' || mode === 'full' ? 'full' : 'push'
      return running
    }
    running = (async () => {
      // This cycle commits everything dirty so far — a pending debounce pass
      // (e.g. queued before a launch/focus/manual sync) would only duplicate it.
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      deadline = null
      emit({ state: 'syncing' })
      try {
        await cycle(mode)
        emit({ state: 'idle' })
      } catch (error) {
        if (!signal.aborted) {
          emit(statusForError(error))
        }
      } finally {
        running = null
        if (rerunMode !== null && !signal.aborted) {
          const next = rerunMode
          rerunMode = null
          void run(next)
        }
      }
    })()
    return running
  }

  async function cycle(mode: 'push' | 'full'): Promise<void> {
    const token = await step(options.getToken())
    const commit = await step(gitCommitAll('Update notes', options.generation))
    if (commit.skippedLargeFiles.length > 0) {
      options.onLargeFilesSkipped?.(commit.skippedLargeFiles)
    }
    if (mode === 'push') {
      // The debounce path often fires for changes that are already committed
      // and pushed (a pull's own writes re-enter via the watcher). Nothing
      // committed and nothing ahead means a push would be a pointless network
      // negotiation — end the cycle without one.
      if (!commit.committed && commit.ahead === 0) {
        return
      }
    } else {
      // Launch/focus: pick up other devices' changes even with nothing to push.
      const delta = await step(gitFetch(token, options.generation))
      const merged = await merge()
      const localOnly = commit.committed || delta.ahead > 0
      if (!localOnly && (merged.kind === 'upToDate' || merged.kind === 'fastForward')) {
        return // pulled cleanly and have nothing of our own — no push needed
      }
    }
    for (let attempt = 0; attempt < MAX_PUSH_ATTEMPTS; attempt++) {
      const push = await step(gitPush(token, options.generation))
      if (push.pushed) {
        return
      }
      if (!push.nonFastForward) {
        throw new PushRejectedError(push.rejectionMessage ?? 'the remote rejected the backup')
      }
      // The normal two-device race: another device pushed first. Converge and
      // retry — a conflicted merge still commits (markers in the note).
      await step(gitFetch(token, options.generation))
      await merge()
    }
    throw new PushRejectedError(
      'the backup repo kept changing while syncing; will retry on the next edit',
    )
  }

  /** Merge the fetched remote and hand any changed files to the reindexer. */
  async function merge(): Promise<{ kind: string }> {
    const outcome = await step(gitMergeRemote(options.generation)) // upToDate is a no-op
    if (outcome.changedFiles.length > 0) {
      options.onRemoteChanges?.(outcome.changedFiles)
    }
    return outcome
  }

  function syncNow(): Promise<void> {
    return run('full')
  }

  function stop(): void {
    abort.abort()
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return { noteChanged, syncNow, stop }
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
