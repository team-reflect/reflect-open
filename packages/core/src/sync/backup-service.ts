import type { MaybePromise } from '@reflect/utils'
import { isCaptureSpoolPath } from '../capture/capture-identity.ts'
import type { ActivityPort } from '../ports/activity-port.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { PersistenceFlushService } from '../graph/persistence-flush-service.ts'
import type { PlatformFacts } from '../ports/platform-facts.ts'
import { isMobilePlatform } from '../ports/platform-facts.ts'
import { errorMessage, ReflectError } from '../errors.ts'
import { isNotePath } from '../graph/paths.ts'
import type { FileChangeService } from '../indexing/file-change-service.ts'
import type { IndexLifecycleService } from '../indexing/index-lifecycle-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type { ICloudNativeService } from '../ipc/icloud-native-service.ts'
import type { ClockService, TimerHandle } from '../ports/clock-service.ts'
import { isICloudRoot } from './icloud-sync-service.ts'
import { isSyncError, type SyncEngine, type SyncEngineFactory, type SyncStatus } from './engine.ts'
import { describeConflictCopies } from './conflict-copies.ts'
import type { ChangedFile, GitCredential, GitRepositoryService } from './git-repository-service.ts'
import { githubCredential, type GithubAuthService } from './github-auth-service.ts'
import {
  githubRemoteUrl,
  parseGithubRemote,
  remoteHost,
  type GithubRepoRef,
  type GithubRepoService,
} from './github-repo-service.ts'

/**
 * Backup state as the UI sees it. `connected` means the graph has a repo and
 * an `origin` remote, and the engine is running. `repo` is set for GitHub
 * remotes (which additionally require the stored GitHub credential) and
 * `null` for hand-wired generic remotes (Plan 16: GitLab/Gitea/self-hosted
 * over SSH, or a bare path repo), whose credentials resolve locally in Rust.
 *
 * `disconnected` means no *backup*: on desktop such graphs still run the
 * local-history commit loop (see `startLocalHistory`), which the UI never
 * surfaces.
 */
export type BackupState =
  | { phase: 'loading' }
  | { phase: 'disconnected' }
  | { phase: 'connected'; remoteUrl: string; repo: GithubRepoRef | null; status: SyncStatus }

/**
 * Outcome of connecting to an existing repo (the public case needs consent).
 */
export type ConnectExistingResult = 'connected' | 'needsPublicConfirm' | 'notFound'

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
 * Quiet period before the network pass on an iCloud-hosted graph with a
 * remote. iCloud and Git then both move the same files, so Git waits until
 * iCloud and the user have both stopped.
 */
const COEXIST_QUIET_MS = 5 * 60_000

/**
 * How often a visible desktop window asks the remote for its branch tip.
 */
const REMOTE_PROBE_MS = 90_000

/**
 * The (graph, index session) pair one {@link BackupService} backs up.
 */
export interface BackupServiceOptions {
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
 * The services a {@link BackupService} runs on.
 */
export interface BackupServiceDeps {
  readonly git: GitRepositoryService
  readonly syncEngines: SyncEngineFactory
  readonly githubAuth: GithubAuthService
  readonly githubRepos: GithubRepoService
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
 * The per-graph backup lifecycle, extracted from React on purpose: every
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
 * hook, and the connect / disconnect / sign-out / back-up-now actions.
 */
export interface BackupService {
  /**
   * Probe the graph and start the engine if fully connected. Idempotent.
   */
  start(): Promise<void>
  getState: () => BackupState
  /**
   * Subscribe to state changes; returns the unsubscribe.
   */
  subscribe: (listener: () => void) => Unlisten
  /**
   * Create a new **private** repo for the signed-in user and connect it.
   * `manualCreateNeeded` means the token *type* can't create repositories
   * (fine-grained PATs can't call `POST /user/repos`) — the dialog falls
   * back to the prefilled github.com/new handoff and connects afterwards.
   */
  connectNewRepo(name: string): Promise<'connected' | 'manualCreateNeeded'>
  /**
   * Connect an existing repo. A public repo returns `needsPublicConfirm`
   * unless `allowPublic` — everything in the graph (including `private:
   * true` notes) would be world-readable, so that needs an explicit yes.
   */
  connectExistingRepo(
    ref: GithubRepoRef,
    options?: { allowPublic?: boolean | undefined },
  ): Promise<ConnectExistingResult>
  /**
   * Stop backing **this graph** up (drops its remote; history and the
   * machine-level GitHub credential stay — other graphs keep syncing).
   */
  disconnectGraph(): Promise<void>
  /**
   * Sign this machine out of GitHub — every connected graph stops syncing.
   */
  signOut(): Promise<void>
  /**
   * Full cycle now: fetch, pull, push. On an iCloud-hosted graph with a remote
   * it commits, and opens a quiet window only when none is open.
   */
  backUpNow(): Promise<void>
  /**
   * Tear everything down; the service is unusable afterwards.
   */
  dispose(): void
}

class BackupServiceImpl implements BackupService {
  readonly #deps: BackupServiceDeps
  readonly #generation: number
  readonly #root: string
  readonly #indexGeneration: number | null
  readonly #mobile: boolean
  readonly #listeners = new Set<() => void>()
  readonly #resumeDisposers: Array<() => void> = []
  #state: BackupState = { phase: 'loading' }
  #disposed = false
  #engine: SyncEngine | null = null
  #unlisten: Unlisten | null = null
  #unregisterBackupFlusher: (() => void) | null = null
  #probeTimer: TimerHandle | null = null
  /**
   * Serializes direct index writes without delaying synchronous file-change fanout.
   */
  #remoteIndexTail: Promise<void> = Promise.resolve()
  /**
   * Invalidates index work that was queued before a service teardown/restart.
   */
  #remoteIndexEpoch = 0

  constructor(deps: BackupServiceDeps, options: BackupServiceOptions) {
    this.#deps = deps
    this.#generation = options.generation
    this.#root = options.root
    this.#indexGeneration = options.indexGeneration
    this.#mobile = isMobilePlatform(deps.platform.appPlatform) || deps.platform.surface.mobileApp
  }

  async start(): Promise<void> {
    const { git, syncEngines, githubAuth, progress, activity, logger, icloudNative, platform } =
      this.#deps
    this.#teardown()
    if (this.#disposed) {
      return
    }
    this.#setState({ phase: 'loading' })
    try {
      const [status, auth] = await Promise.all([
        git.status(this.#generation),
        // A keychain the app can't read is indistinguishable from a signed-out
        // one as far as backup is concerned, and must not cost the graph its
        // history: degrade to the signed-out path below rather than failing
        // the whole start into the engine-less catch.
        githubAuth.load().catch((error: unknown) => {
          logger.error('reading the GitHub credential failed:', errorMessage(error))
          return null
        }),
      ])
      if (this.#disposed) {
        return
      }
      if (!status.initialized || status.remoteUrl === null) {
        this.#setState({ phase: 'disconnected' })
        await this.#startLocalHistory(status.initialized)
        return
      }
      const remoteUrl = status.remoteUrl
      const repo = parseGithubRemote(remoteUrl)
      if (repo !== null && auth === null) {
        // A GitHub remote needs the managed sign-in; the wizard is the fix.
        // Generic remotes adopt without it — their credentials live with the
        // user's own git tooling (ssh agent), not in our keychain.
        this.#setState({ phase: 'disconnected' })
        await this.#startLocalHistory(status.initialized)
        return
      }
      // The app has no sign-in for a non-GitHub HTTPS host (SSH and path
      // remotes need none: the agent or the filesystem answers). Fail at
      // adoption, not at the first push: a *public* HTTPS remote would pull
      // anonymously and only 401 on push, so the other device's edits arrive
      // while this one's silently never leave. `rejected` = acting (not
      // retrying) is the fix.
      const host = repo === null ? remoteHost(remoteUrl) : null
      if (host !== null) {
        this.#setState({
          phase: 'connected',
          remoteUrl,
          repo: null,
          status: {
            state: 'error',
            errorKind: 'rejected',
            message: `Backup cannot sign in to ${host} over HTTPS. Switch the remote to its SSH form: git remote set-url origin git@${host}:<owner>/<repo>.git`,
          },
        })
        await this.#startLocalHistory(status.initialized)
        return
      }
      // The managed sign-in is for github.com only; SSH and path remotes get
      // none and Rust resolves them locally.
      const getCredential =
        repo !== null
          ? async () => {
              const token = await githubAuth.getToken()
              return token === null ? null : githubCredential(token)
            }
          : async () => null
      const coexisting = isICloudRoot(this.#root)
      const next = syncEngines.create({
        generation: this.#generation,
        idleMs: this.#mobile ? MOBILE_IDLE_MS : undefined,
        quietMs: coexisting ? COEXIST_QUIET_MS : undefined,
        networkReady: coexisting
          ? async () => (await icloudNative.pendingCount(this.#root, 'notes')) === 0
          : undefined,
        // iOS can suspend us at any await. Do not begin a launch, online, or
        // debounced Git cycle after the document is hidden; the existing
        // visible/focus trigger below replays a full cycle on foreground.
        // The background flusher's protected local commit bypasses this
        // engine deliberately.
        canStartCycle: () => !this.#mobile || !activity.isHidden(),
        getCredential,
        onStatus: (engineStatus) => {
          this.#setState({ phase: 'connected', remoteUrl, repo, status: engineStatus })
          if (repo !== null && isForbidden(engineStatus)) {
            void this.#classifyForbidden(engineStatus, remoteUrl, repo)
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
      this.#setState({ phase: 'connected', remoteUrl, repo, status: { state: 'idle' } })
      this.#adoptEngine(next)

      this.#resumeDisposers.push(activity.subscribeResume(() => void next.syncNow()))
      if (!coexisting && !this.#mobile && platform.isNativeShell) {
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

  readonly getState = (): BackupState => this.#state

  readonly subscribe = (listener: () => void): Unlisten => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  async connectNewRepo(name: string): Promise<'connected' | 'manualCreateNeeded'> {
    const { githubRepos } = this.#deps
    const token = await this.#requireToken()
    const repo = await githubRepos.createRepo(token, name, { isPrivate: true })
    if (repo === null) {
      return 'manualCreateNeeded' // fine-grained PATs can't create repos
    }
    const [owner, repoName, ...rest] = repo.fullName.split('/')
    if (owner === undefined || repoName === undefined || rest.length > 0) {
      throw new ReflectError('parse', `unexpected repository name from GitHub: ${repo.fullName}`)
    }
    // Align with the account's default branch for new repos so the first
    // push creates the branch GitHub already considers the default.
    await this.#connectRemote(githubRemoteUrl({ owner, name: repoName }), repo.defaultBranch)
    return 'connected'
  }

  async connectExistingRepo(
    ref: GithubRepoRef,
    connectOptions: { allowPublic?: boolean } = {},
  ): Promise<ConnectExistingResult> {
    const { githubRepos } = this.#deps
    const token = await this.#requireToken()
    const repo = await githubRepos.getRepo(token, ref)
    if (repo === null) {
      return 'notFound'
    }
    if (!repo.isPrivate && connectOptions.allowPublic !== true) {
      return 'needsPublicConfirm'
    }
    // The repo's default branch is where its existing backup history lives —
    // the local branch must match or sync would fork a parallel branch.
    await this.#connectRemote(githubRemoteUrl(ref), repo.defaultBranch)
    return 'connected'
  }

  async disconnectGraph(): Promise<void> {
    await this.#deps.git.disconnect(this.#generation)
    await this.start()
  }

  async signOut(): Promise<void> {
    await this.#deps.githubAuth.clear()
    await this.start()
  }

  async backUpNow(): Promise<void> {
    await this.#engine?.syncNow()
  }

  dispose(): void {
    this.#disposed = true
    this.#teardown()
    this.#listeners.clear()
  }

  #setState(next: BackupState): void {
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
    this.#unregisterBackupFlusher?.()
    this.#unregisterBackupFlusher = null
  }

  #clearProbe(): void {
    if (this.#probeTimer !== null) {
      this.#deps.clock.clearTimeout(this.#probeTimer)
      this.#probeTimer = null
    }
  }

  #armProbe(engine: SyncEngine, getCredential: () => Promise<GitCredential | null>): void {
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
    getCredential: () => Promise<GitCredential | null>,
  ): Promise<void> {
    const { git, activity, logger } = this.#deps
    const failed = this.#state.phase === 'connected' && this.#state.status.state === 'error'
    if (!activity.isHidden() && !failed) {
      try {
        const tip = await git.remoteHead(await getCredential(), this.#generation)
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
    const fileChangeBatch = changes.map(({ path, kind, modifiedMs }) =>
      modifiedMs === null || modifiedMs === undefined ? { path, kind } : { path, kind, modifiedMs },
    )
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
    this.#unregisterBackupFlusher = persistenceFlush.registerFlusher('backup', () =>
      next.commitNow(),
    )
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
   * just published: the SSH-only `rejected` message is the user's only
   * instruction for fixing that remote, and losing it to a watcher that
   * happened not to come up would be the worse trade.
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
        getCredential: async () => null,
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

  /**
   * GitHub answers 403 both for a token without access to the repository
   * and for rate limiting. libgit2 cannot tell either from a bad token, so
   * the engine reports `auth` and the UI offers "reconnect GitHub", which
   * fixes neither. Ask GitHub whether the token itself is good: when it is,
   * the push was refused for another reason and the status names it.
   */
  async #classifyForbidden(
    status: SyncStatus,
    remoteUrl: string,
    repo: GithubRepoRef,
  ): Promise<void> {
    const { githubAuth } = this.#deps
    let next: SyncStatus
    try {
      const token = await githubAuth.getToken()
      if (token === null) {
        return
      }
      await githubAuth.getAuthenticatedUser(token)
      next = {
        state: 'error',
        errorKind: 'rejected',
        message: `GitHub refused the sync (403). Check that Reflect has access to ${repo.owner}/${repo.name}, or wait a few minutes if GitHub is rate limiting.`,
      }
    } catch (cause) {
      // A rejected probe confirms the bad credential: `auth` stands. Anything
      // else (GitHub throttling, a fetch that never reached it, an unparsable
      // reply) says nothing about the credential, so it must not keep asking
      // for a reconnect either.
      if (cause instanceof ReflectError && cause.kind === 'auth') {
        return
      }
      next = {
        state: 'offline',
        message: 'GitHub is rate limiting or unreachable; the backup will retry',
      }
    }
    // Only replace the exact status this probe was asked about.
    if (this.#state.phase === 'connected' && this.#state.status === status) {
      this.#setState({ phase: 'connected', remoteUrl, repo, status: next })
    }
  }

  async #requireToken(): Promise<string> {
    const { githubAuth } = this.#deps
    const token = await githubAuth.getToken()
    if (token === null) {
      throw new ReflectError('auth', 'Connect GitHub first (no credential stored)')
    }
    return token
  }

  async #connectRemote(remoteUrl: string, branch: string): Promise<void> {
    const { git } = this.#deps
    await git.setup(remoteUrl, branch, this.#generation)
    await this.start()
  }
}

export function createBackupService(
  deps: BackupServiceDeps,
  options: BackupServiceOptions,
): BackupService {
  return new BackupServiceImpl(deps, options)
}

/**
 * An `auth` error that is really an HTTP 403 (libgit2 phrases it `status code: 403`).
 */
function isForbidden(status: SyncStatus): boolean {
  return isSyncError(status) && status.errorKind === 'auth' && status.message.includes('403')
}

function sameState(a: BackupState, b: BackupState): boolean {
  if (a.phase !== 'connected' || b.phase !== 'connected') {
    return a.phase === b.phase
  }
  return a.remoteUrl === b.remoteUrl && a.repo === b.repo && sameStatus(a.status, b.status)
}

function sameStatus(a: SyncStatus, b: SyncStatus): boolean {
  const left: Record<string, unknown> = a
  const right: Record<string, unknown> = b
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}
