import type { MaybePromise } from '@reflect/utils'
import { isCaptureSpoolPath } from '../capture/capture-identity.ts'
import type { ActivityPort } from '../ports/activity-port.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { PersistenceFlushService } from '../graph/persistence-flush-service.ts'
import type { PlatformFacts } from '../ports/platform-facts.ts'
import { isMobilePlatform } from '../ports/platform-facts.ts'
import { errorMessage } from '../errors.ts'
import { isNotePath } from '../graph/paths.ts'
import type { FileChangeService } from '../indexing/file-change-service.ts'
import type { IndexLifecycleService } from '../indexing/index-lifecycle-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type { ICloudNativeService } from '../ipc/icloud-native-service.ts'
import type { ClockService, TimerHandle } from '../ports/clock-service.ts'
import { isICloudRoot } from './icloud-sync-service.ts'
import { isSyncError, type SyncEngine, type SyncEngineFactory, type SyncStatus } from './engine.ts'
import { describeConflictCopies } from './conflict-copies.ts'
import type { CredentialResolver } from './credential-resolver.ts'
import type { GitHostCredentialService } from './git-host-credential-service.ts'
import type { ChangedFile, GitCredential, GitRepositoryService } from './git-repository-service.ts'
import type { GithubAuthService } from './github-auth-service.ts'
import { classifyForbiddenStatus } from './github-forbidden.ts'
import { classifyRemote, type GitRemote } from './remote-url.ts'

/**
 * Git sync state as the UI sees it. `connected` means the graph has a repo,
 * an `origin` remote, the sign-in that remote needs, and a running engine.
 * `needsCredential` means `origin` is set but its sign-in is not stored: the
 * GitHub account is signed out, or the HTTPS host has no entry. SSH and path
 * remotes never land there: Rust resolves them locally.
 *
 * `disconnected` means no remote: on desktop such graphs still run the
 * local-history commit loop (see `startLocalHistory`), which the UI never
 * surfaces. So does `needsCredential`.
 */
export type GitSyncState =
  | { phase: 'loading' }
  | { phase: 'disconnected' }
  | { phase: 'needsCredential'; remoteUrl: string; remote: GitRemote }
  | {
      phase: 'connected'
      remoteUrl: string
      remote: GitRemote
      /**
       * True when this repository is the channel that carries the notes
       * between devices. False on an iCloud-hosted graph: iCloud carries
       * them, and Git keeps a history that updates after five quiet minutes.
       */
      isPrimaryChannel: boolean
      status: SyncStatus
    }

/**
 * Quiet period after the last edit before a backup commit, on mobile.
 * Desktop keeps the engine's 30s default, but mobile foreground sessions are
 * often shorter than that — with the desktop window most edit-triggered
 * cycles would never fire before backgrounding, deferring every push to the
 * *next* app open. (Capture is still never lost either way: the background
 * flush commits locally.)
 */
const MOBILE_IDLE_MS = 10_000

/**
 * Quiet period before the network pass when Git is not the primary channel
 * (an iCloud-hosted graph with a remote). iCloud and Git then both move the
 * same files, so Git waits until iCloud and the user have both stopped.
 */
const SECONDARY_CHANNEL_QUIET_MS = 5 * 60_000

/**
 * How often a visible desktop window asks the remote for its branch tip.
 */
const REMOTE_PROBE_MS = 90_000

/**
 * The (graph, index session) pair one {@link GitSyncService} backs up.
 */
export interface GitSyncServiceOptions {
  /**
   * The open graph's root folder.
   */
  readonly root: string
  /**
   * The open graph's generation — every git command is pinned to it.
   */
  readonly generation: number
  /**
   * The open index session's generation — index writes are pinned to it.
   */
  readonly indexGeneration: number | null
}

/**
 * The services a {@link GitSyncService} runs on.
 */
export interface GitSyncServiceDeps {
  readonly git: GitRepositoryService
  readonly syncEngines: SyncEngineFactory
  /**
   * Which sign-in the graph's remote gets.
   */
  readonly credentials: CredentialResolver
  /**
   * A change to either sign-in store restarts the service, so a remote that
   * needed a sign-in picks it up and one that lost it stops.
   */
  readonly githubAuth: GithubAuthService
  readonly hostCredentials: GitHostCredentialService
  readonly fileChanges: FileChangeService
  /**
   * Applies the notes a pull changed.
   */
  readonly indexLifecycle: IndexLifecycleService
  readonly progress: ProgressPort
  readonly clock: ClockService
  readonly activity: ActivityPort
  readonly platform: PlatformFacts
  readonly persistenceFlush: PersistenceFlushService
  readonly logger: LoggerService
  /**
   * Reports the iCloud downloads still pending for an iCloud-hosted graph.
   */
  readonly icloudNative: ICloudNativeService
}

/**
 * The per-graph git sync lifecycle, extracted from React on purpose: every
 * review finding against this feature landed in the provider's effect/engine
 * seam (zombie engines on partial init, leaked listeners, resurrection after
 * teardown). Here the lifecycle is one object with one `teardown()` that
 * every path — success, partial-init failure, dispose — funnels through, and
 * the provider shrinks to a `useSyncExternalStore` shim. One service serves
 * one (graph, index session) pair.
 *
 * Owns: the connection probe, the sync engine, the watcher subscription that
 * feeds its debounce, the resume triggers (launch, window focus, visibility →
 * visible for mobile app resume, and back-online pulls), the quit-commit
 * hook, and the connect / disconnect / sync-now actions. Which remote to
 * connect is the connectors' business (`GithubConnector`, `HostConnector`).
 */
export interface GitSyncService {
  /**
   * Probe the graph and start the engine if fully connected. Idempotent;
   * overlapping calls run one after the other.
   */
  start(): MaybePromise<void>
  getState: () => GitSyncState
  /**
   * Subscribe to state changes; returns the unsubscribe.
   */
  subscribe: (listener: () => void) => Unlisten
  /**
   * Point `origin` at `remoteUrl`, align the local branch with `branch` (the
   * remote's default, so sync never forks a parallel branch), and restart.
   */
  connectRemote(remoteUrl: string, branch: string | null): Promise<void>
  /**
   * Stop syncing **this graph** (drops its remote; history and every
   * sign-in stay — other graphs keep syncing).
   */
  disconnectGraph(): MaybePromise<void>
  /**
   * Full cycle now: fetch, pull, push. On an iCloud-hosted graph with a remote
   * it commits, and opens a quiet window only when none is open.
   */
  syncNow(): MaybePromise<void>
  /**
   * Tear everything down; the service is unusable afterwards.
   */
  dispose(): void
}

class GitSyncServiceImpl implements GitSyncService {
  readonly #deps: GitSyncServiceDeps
  readonly #generation: number
  readonly #root: string
  readonly #indexGeneration: number | null
  readonly #mobile: boolean
  readonly #listeners = new Set<() => void>()
  readonly #resumeDisposers: Array<() => void> = []
  readonly #credentialDisposers: Array<() => void> = []
  /**
   * Serializes `start()` calls: two in flight at once would adopt two engines.
   */
  #startTail: Promise<void> = Promise.resolve()
  #state: GitSyncState = { phase: 'loading' }
  #disposed = false
  #engine: SyncEngine | null = null
  #unlisten: Unlisten | null = null
  #unregisterGitSyncFlusher: (() => void) | null = null
  #probeTimer: TimerHandle | null = null
  /**
   * Serializes direct index writes without delaying synchronous file-change fanout.
   */
  #remoteIndexTail: Promise<void> = Promise.resolve()
  /**
   * Invalidates index work that was queued before a service teardown/restart.
   */
  #remoteIndexEpoch = 0

  constructor(deps: GitSyncServiceDeps, options: GitSyncServiceOptions) {
    this.#deps = deps
    this.#generation = options.generation
    this.#root = options.root
    this.#indexGeneration = options.indexGeneration
    this.#mobile = isMobilePlatform(deps.platform.appPlatform) || deps.platform.surface.mobileApp
  }

  start(): Promise<void> {
    const run = this.#startTail.then(() => this.#runStart())
    this.#startTail = run.catch(() => undefined)
    return run
  }

  async #runStart(): Promise<void> {
    const { git, syncEngines, credentials, progress, activity, logger, icloudNative, platform } =
      this.#deps
    this.#teardown()
    if (this.#disposed) {
      return
    }
    this.#setState({ phase: 'loading' })
    try {
      const status = await git.status(this.#generation)
      if (this.#disposed) {
        return
      }
      if (!status.initialized || status.remoteUrl === null) {
        this.#setState({ phase: 'disconnected' })
        await this.#startLocalHistory(status.initialized)
        return
      }
      const remoteUrl = status.remoteUrl
      const remote = classifyRemote(remoteUrl)
      // A missing sign-in fails at adoption, not at the first push: a public
      // HTTPS remote would pull anonymously and only 401 on push, so the other
      // device's edits arrive while this one's silently never leave.
      const resolved = await credentials.resolve(remote)
      if (this.#disposed) {
        return
      }
      // Subscribed only now: the resolver's first keychain read notifies the
      // GitHub store's own subscribers, and that read is not a change.
      this.#watchCredentials()
      if (resolved.kind === 'missing') {
        this.#setState({ phase: 'needsCredential', remoteUrl, remote })
        await this.#startLocalHistory(status.initialized)
        return
      }
      const getCredential = resolved.get
      const isPrimaryChannel = !isICloudRoot(this.#root)
      const next = syncEngines.create({
        generation: this.#generation,
        idleMs: this.#mobile ? MOBILE_IDLE_MS : undefined,
        quietMs: isPrimaryChannel ? undefined : SECONDARY_CHANNEL_QUIET_MS,
        networkReady: isPrimaryChannel
          ? undefined
          : async () => (await icloudNative.pendingCount(this.#root, 'notes')) === 0,
        // iOS can suspend us at any await. Do not begin a launch, online, or
        // debounced Git cycle after the document is hidden; the existing
        // visible/focus trigger below replays a full cycle on foreground.
        // The background flusher's protected local commit bypasses this
        // engine deliberately.
        canStartCycle: () => !this.#mobile || !activity.isHidden(),
        getCredential,
        onStatus: (engineStatus) => {
          this.#setState({
            phase: 'connected',
            remoteUrl,
            remote,
            isPrimaryChannel,
            status: engineStatus,
          })
          if (remote.kind === 'github' && isForbidden(engineStatus)) {
            void this.#classifyForbidden(engineStatus, remoteUrl, remote, isPrimaryChannel)
          }
        },
        onLargeFilesSkipped: (files) => {
          // Surface the guardrail loudly: these files are NOT in the backup.
          const names = files.map((file) => file.path).join(', ')
          progress.fail('Backing up', `Too large to back up (kept local): ${names}`)
        },
        onRemoteChanges: (changes) => this.#onRemoteChanges(changes),
        onReview: (paths) => progress.fail('Syncing', describeConflictCopies(paths)),
      })
      this.#setState({
        phase: 'connected',
        remoteUrl,
        remote,
        isPrimaryChannel,
        status: { state: 'idle' },
      })
      this.#adoptEngine(next)

      this.#resumeDisposers.push(activity.subscribeResume(() => void next.syncNow()))
      if (isPrimaryChannel && !this.#mobile && platform.isNativeShell) {
        this.#armProbe(next, getCredential)
      }

      void next.syncNow() // launch pull: pick up other devices' changes
    } catch (error) {
      // Any partially-built lifecycle is torn down whole — no zombie engine
      // keeps timers or git work running behind a disconnected UI.
      this.#teardown()
      if (!this.#disposed) {
        logger.error('backup start failed:', errorMessage(error))
        this.#setState({ phase: 'disconnected' })
      }
    }
  }

  readonly getState = (): GitSyncState => this.#state

  readonly subscribe = (listener: () => void): Unlisten => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  async disconnectGraph(): Promise<void> {
    await this.#deps.git.disconnect(this.#generation)
    await this.start()
  }

  async syncNow(): Promise<void> {
    await this.#engine?.syncNow()
  }

  async connectRemote(remoteUrl: string, branch: string | null): Promise<void> {
    await this.#deps.git.setup(remoteUrl, branch, this.#generation)
    await this.start()
  }

  dispose(): void {
    this.#disposed = true
    this.#teardown()
    for (const dispose of this.#credentialDisposers.splice(0)) {
      dispose()
    }
    this.#listeners.clear()
  }

  /**
   * Restart when a sign-in store changes: a remote that was waiting for its
   * sign-in picks it up; a GitHub remote whose account signed out stops. SSH
   * and path remotes take no sign-in, so nothing restarts them.
   */
  #watchCredentials(): void {
    if (this.#credentialDisposers.length > 0) {
      return
    }
    const onChange = (): void => {
      const state = this.#state
      const affected =
        state.phase === 'needsCredential' ||
        (state.phase === 'connected' &&
          (state.remote.kind === 'github' || state.remote.kind === 'https'))
      if (affected) {
        void this.start()
      }
    }
    this.#credentialDisposers.push(
      this.#deps.githubAuth.subscribe(onChange),
      this.#deps.hostCredentials.subscribe(onChange),
    )
  }

  #setState(next: GitSyncState): void {
    if (this.#disposed || sameState(this.#state, next)) {
      return
    }
    this.#state = next
    for (const listener of this.#listeners) {
      listener()
    }
  }

  /**
   * The single teardown path — every exit (failure, dispose, restart) takes it.
   */
  #teardown(): void {
    this.#remoteIndexEpoch += 1
    this.#clearProbe()
    this.#engine?.stop()
    this.#engine = null
    this.#unlisten?.()
    this.#unlisten = null
    for (const dispose of this.#resumeDisposers.splice(0)) {
      dispose()
    }
    this.#unregisterGitSyncFlusher?.()
    this.#unregisterGitSyncFlusher = null
  }

  #clearProbe(): void {
    if (this.#probeTimer !== null) {
      this.#deps.clock.clearTimeout(this.#probeTimer)
      this.#probeTimer = null
    }
  }

  #armProbe(engine: SyncEngine, getCredential: () => MaybePromise<GitCredential | null>): void {
    this.#probeTimer = this.#deps.clock.setTimeout(() => {
      this.#probeTimer = null
      void this.#probe(engine, getCredential)
    }, REMOTE_PROBE_MS)
  }

  /**
   * One probe tick: ask the remote for its branch tip and pull when it moved.
   * A failed probe is logged and the next one runs on schedule.
   */
  async #probe(
    engine: SyncEngine,
    getCredential: () => MaybePromise<GitCredential | null>,
  ): Promise<void> {
    const { git, activity, logger } = this.#deps
    const failed = this.#state.phase === 'connected' && this.#state.status.state === 'error'
    if (!activity.isHidden() && !failed) {
      try {
        const credential = await getCredential()
        const tip = await git.remoteHead(credential, this.#generation)
        if (this.#engine !== engine) {
          return
        }
        if (tip.remoteOid !== null && tip.remoteOid !== tip.trackingOid) {
          void engine.syncNow()
        }
      } catch (error) {
        if (this.#engine !== engine) {
          return
        }
        logger.info('remote probe failed:', errorMessage(error))
      }
    }
    if (this.#engine === engine) {
      this.#armProbe(engine, getCredential)
    }
  }

  #onRemoteChanges(changes: ChangedFile[]): MaybePromise<void> {
    const { fileChanges, indexLifecycle, activity, logger } = this.#deps
    if (changes.length === 0) {
      return
    }
    // Capture before fanout: a synchronous subscriber can tear down/restart
    // the service, and work from this old merge must remain invalidated.
    const notificationEpoch = this.#remoteIndexEpoch
    // Pull-applied writes must not depend on the file watcher being up (the
    // launch pull can land before watch start), so consumers are notified
    // directly. The whole batch goes to the local file-changes channel —
    // every subscriber filters by path (open editors match their own note,
    // the index and embeddings take markdown notes, the audio-memo
    // reconciler takes recordings) — and the index additionally gets a
    // direct apply (idempotent if a live watcher subscription double-applies).
    const fileChangeBatch = changes.map(({ path, kind, modifiedMs }) => {
      return modifiedMs === null || modifiedMs === undefined
        ? { path, kind }
        : { path, kind, modifiedMs }
    })
    fileChanges.emit({ changes: fileChangeBatch, source: 'pull' })
    const indexable = fileChangeBatch.filter((change) => isNotePath(change.path))
    const indexGeneration = this.#indexGeneration
    if (indexGeneration !== null && indexable.length > 0) {
      const task = this.#remoteIndexTail.then(async () => {
        // Teardown stops the engine and invalidates work that has not begun.
        // A landed merge was already fanned out synchronously above; the next
        // watcher/reconcile pass can rebuild this disposable projection.
        if (this.#disposed || notificationEpoch !== this.#remoteIndexEpoch) {
          return
        }
        await indexLifecycle.applyChanges(
          indexable,
          indexGeneration,
          this.#generation,
          () => !this.#mobile || !activity.isHidden(),
        )
      })
      // Direct index writes remain ordered across retry merges. Their handled
      // promise is what the engine joins before idle; failure is logged but
      // never prevents the already-concurrent Git push of Markdown truth.
      this.#remoteIndexTail = task.catch((cause) => {
        logger.error('pulled-note direct index apply failed:', cause)
      })
      return this.#remoteIndexTail
    }
  }

  /**
   * Wire an engine into the watcher (which feeds its debounce) and the
   * quit-time flusher.
   */
  #adoptEngine(next: SyncEngine): void {
    const { fileChanges, persistenceFlush } = this.#deps
    this.#engine = next
    // Spooled capture envelopes (`.reflect/inbox/`) are git-ignored and
    // drained within seconds — they must not tick the commit debounce. The
    // drain's own note writes arrive as ordinary changes right after.
    this.#unlisten = fileChanges.subscribe(({ changes, source }) => {
      if (source === 'pull') {
        return
      }
      if (changes.some((change) => !isCaptureSpoolPath(change.path))) {
        next.noteChanged()
      }
    })
    // Quit-time commit (local only — never a network push on the way out),
    // queued behind any running cycle so it can never land between a pull's
    // ref move and its checkout.
    this.#unregisterGitSyncFlusher = persistenceFlush.registerFlusher('git-sync', () => {
      return next.commitNow()
    })
  }

  /**
   * Local history (desktop only): a graph the sync engine can't run for still
   * gets a repository and the debounced commit loop, so every edit lands in
   * Git history and stays revertable — nothing is ever fetched or pushed.
   * Connecting a backup later adopts this repository, history included.
   *
   * This runs on the desktop paths that end without a syncing engine, not
   * just "no remote": a graph whose `origin` is a GitHub repo the machine is
   * no longer signed in to, and one whose remote we refuse to adopt, both
   * keep committing locally. Otherwise a signed-out remote silently downgrades
   * the graph to no history at all — worse than never having connected one.
   * The one no-engine path it deliberately skips is a failed `gitStatus`,
   * which leaves the repo state unknown: `gitSetup` there could initialize a
   * repository on a broken graph. A failed *credential* read is not that case,
   * so `start()` degrades it to the signed-out path above instead.
   *
   * Starting it is best effort. It must never take down the state the caller
   * just published: `needsCredential` names the remote the user has to sign
   * in to, and losing it to a watcher that happened not to come up would be
   * the worse trade.
   */
  async #startLocalHistory(initialized: boolean): Promise<void> {
    const { git, syncEngines, platform, logger } = this.#deps
    // Real git on a real folder — a shell capability the browser-dev bridge
    // honestly lacks, so don't start (and noisily fail) the commit loop there.
    if (this.#mobile || !platform.isNativeShell) {
      return
    }
    try {
      if (!initialized) {
        await git.setup(null, null, this.#generation)
      }
      if (this.#disposed) {
        return
      }
      const next = syncEngines.create({
        generation: this.#generation,
        localOnly: true,
        getCredential: () => null,
        onStatus: (engineStatus) => {
          // No UI surfaces local history, so a failing commit loop (disk full,
          // corrupted repo) must at least leave a trace for diagnosis.
          if (engineStatus.state === 'error') {
            logger.error('local history commit failed:', engineStatus.message)
          }
        },
      })
      this.#adoptEngine(next)
      void next.syncNow() // first snapshot: commit whatever is already pending
    } catch (error) {
      // `adoptEngine` assigns the engine before it subscribes, so a
      // half-built lifecycle takes the same teardown as every other failure.
      // No zombie engine keeps timers alive behind the caller's state.
      this.#teardown()
      logger.error('local history failed to start:', errorMessage(error))
    }
  }

  async #classifyForbidden(
    status: SyncStatus,
    remoteUrl: string,
    remote: Extract<GitRemote, { kind: 'github' }>,
    isPrimaryChannel: boolean,
  ): Promise<void> {
    const next = await classifyForbiddenStatus(this.#deps.githubAuth, remote.repo)
    // Only replace the exact status this probe was asked about.
    if (next !== null && this.#state.phase === 'connected' && this.#state.status === status) {
      this.#setState({ phase: 'connected', remoteUrl, remote, isPrimaryChannel, status: next })
    }
  }
}

export function createGitSyncService(
  deps: GitSyncServiceDeps,
  options: GitSyncServiceOptions,
): GitSyncService {
  return new GitSyncServiceImpl(deps, options)
}

/**
 * An `auth` error that is really an HTTP 403 (libgit2 phrases it `status code: 403`).
 */
function isForbidden(status: SyncStatus): boolean {
  return isSyncError(status) && status.errorKind === 'auth' && status.message.includes('403')
}

function sameState(a: GitSyncState, b: GitSyncState): boolean {
  if (a.phase === 'needsCredential' && b.phase === 'needsCredential') {
    return a.remoteUrl === b.remoteUrl
  }
  if (a.phase !== 'connected' || b.phase !== 'connected') {
    return a.phase === b.phase
  }
  return (
    a.remoteUrl === b.remoteUrl &&
    a.isPrimaryChannel === b.isPrimaryChannel &&
    sameStatus(a.status, b.status)
  )
}

function sameStatus(a: SyncStatus, b: SyncStatus): boolean {
  const left: Record<string, unknown> = a
  const right: Record<string, unknown> = b
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}
