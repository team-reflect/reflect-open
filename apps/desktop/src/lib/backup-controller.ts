import {
  applyIndexChanges,
  clearGithubAuth,
  createGithubRepo,
  createSyncEngine,
  emitFileChanges,
  errorMessage,
  getGithubRepo,
  getGithubToken,
  githubRemoteUrl,
  gitCommitAll,
  gitDisconnect,
  gitSetup,
  gitStatus,
  isCaptureSpoolPath,
  isNotePath,
  saveGitCredential,
  githubCredential,
  isValidGitCredential,
  loadGitCredential,
  loadGithubAuth,
  parseGithubRemote,
  remoteCredentialOrigin,
  ReflectError,
  subscribeFileChanges,
  type ChangedFile,
  type GithubRepoRef,
  type GraphInfo,
  type GitCredential,
  type SyncEngine,
  type SyncStatus,
  type Unlisten,
} from '@reflect/core'
import { setBackupFlusher } from '@/lib/backup-flush.ts'
import { invalidateGithubAuth } from '@/lib/github-auth-state.ts'
import { startOperation } from '@/lib/operations.ts'
import { isNativeShell } from '@/lib/platform.ts'
import { isMobileSurface } from '@/lib/platform-surface.ts'
import { providerFetch } from '@/lib/provider-fetch.ts'
import { throttledInvalidateIndexQueries } from '@/lib/query-client.ts'
import { attachResumeListeners } from '@/lib/resume-listeners.ts'

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

/** Outcome of connecting to an existing repo (the public case needs consent). */
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

export interface BackupControllerOptions {
  graph: GraphInfo
  /** The open index session's generation — index writes are pinned to it. */
  indexGeneration: number | null
}

/**
 * The per-graph backup lifecycle, extracted from React on purpose: every
 * review finding against this feature landed in the provider's effect/engine
 * seam (zombie engines on partial init, leaked listeners, resurrection after
 * teardown). Here the lifecycle is one object with one `teardown()` that
 * every path — success, partial-init failure, dispose — funnels through, and
 * the provider shrinks to a `useSyncExternalStore` shim.
 *
 * Owns: the connection probe, the sync engine, the watcher subscription that
 * feeds its debounce, the resume triggers (launch, window focus, visibility →
 * visible for mobile app resume, and back-online pulls), the quit-commit
 * hook, and the connect / disconnect / sign-out / back-up-now actions.
 */
export interface BackupController {
  /** Probe the graph and start the engine if fully connected. Idempotent. */
  start(): Promise<void>
  getState(): BackupState
  /** Subscribe to state changes; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
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
    options?: { allowPublic?: boolean },
  ): Promise<ConnectExistingResult>
  /**
   * Connect a non-GitHub host over HTTP(S): store the credential for the
   * remote's origin, point `origin` at it, and restart. A github.com URL is
   * refused — it belongs to the managed sign-in. The credential is per host,
   * so this replaces the one any other graph on that host uses. The local branch is
   * left as-is — there is no host API to ask for a default branch, so an
   * existing repo on a differently-named branch must be matched by the user.
   */
  connectHostRemote(remoteUrl: string, credential: GitCredential): Promise<void>
  /**
   * Stop backing **this graph** up (drops its remote; history and the
   * machine-level credentials — GitHub sign-in and per-host entries — stay,
   * so other graphs on the same host keep syncing).
   */
  disconnectGraph(): Promise<void>
  /** Sign this machine out of GitHub — every connected graph stops syncing. */
  signOut(): Promise<void>
  /** Full cycle now: commit, pull/merge, push. */
  backUpNow(): Promise<void>
  /** Tear everything down; the controller is unusable afterwards. */
  dispose(): void
}

export function createBackupController(options: BackupControllerOptions): BackupController {
  const generation = options.graph.generation
  const indexGeneration = options.indexGeneration

  let state: BackupState = { phase: 'loading' }
  const listeners = new Set<() => void>()
  let disposed = false
  let engine: SyncEngine | null = null
  let unlisten: Unlisten | null = null
  const domDisposers: Array<() => void> = []
  /** Serializes direct index writes without delaying synchronous file-change fanout. */
  let remoteIndexTail: Promise<void> = Promise.resolve()
  /** Invalidates index work that was queued before a controller teardown/restart. */
  let remoteIndexEpoch = 0

  function setState(next: BackupState): void {
    if (disposed) {
      return
    }
    state = next
    for (const listener of listeners) {
      listener()
    }
  }

  /** The single teardown path — every exit (failure, dispose, restart) takes it. */
  function teardown(): void {
    remoteIndexEpoch += 1
    engine?.stop()
    engine = null
    unlisten?.()
    unlisten = null
    for (const dispose of domDisposers.splice(0)) {
      dispose()
    }
    setBackupFlusher(null)
  }

  function onRemoteChanges(changes: ChangedFile[]): void | Promise<void> {
    if (changes.length === 0) {
      return
    }
    // Capture before fanout: a synchronous subscriber can tear down/restart
    // the controller, and work from this old merge must remain invalidated.
    const notificationEpoch = remoteIndexEpoch
    // Pull-applied writes must not depend on the file watcher being up (the
    // launch pull can land before watch start), so consumers are notified
    // directly. The whole batch goes to the local file-changes channel —
    // every subscriber filters by path (open editors match their own note,
    // the index and embeddings take markdown notes, the audio-memo
    // reconciler takes recordings) — and the index additionally gets a
    // direct apply (idempotent if a live watcher subscription double-applies).
    emitFileChanges(changes)
    const indexable = changes.filter((change) => isNotePath(change.path))
    if (indexGeneration !== null && indexable.length > 0) {
      const task = remoteIndexTail.then(async () => {
        // Teardown stops the engine and invalidates work that has not begun.
        // A landed merge was already fanned out synchronously above; the next
        // watcher/reconcile pass can rebuild this disposable projection.
        if (disposed || notificationEpoch !== remoteIndexEpoch) {
          return
        }
        const mutations = await applyIndexChanges(
          indexable,
          indexGeneration,
          undefined,
          undefined,
          () => !isMobileSurface() || document.visibilityState !== 'hidden',
        )
        if (mutations > 0) {
          throttledInvalidateIndexQueries()
        }
      })
      // Direct index writes remain ordered across retry merges. Their handled
      // promise is what the engine joins before idle; failure is logged but
      // never prevents the already-concurrent Git push of Markdown truth.
      remoteIndexTail = task.catch((cause) => {
        console.error('pulled-note direct index apply failed:', cause)
      })
      return remoteIndexTail
    }
  }

  /**
   * Wire an engine into the watcher (which feeds its debounce) and the
   * quit-time flusher. Returns false when teardown or a restart won the race
   * against the subscribe — the engine is already stopped in that case.
   */
  async function adoptEngine(next: SyncEngine): Promise<boolean> {
    engine = next
    // Spooled capture envelopes (`.reflect/inbox/`) are git-ignored and
    // drained within seconds — they must not tick the commit debounce. The
    // drain's own note writes arrive as ordinary changes right after.
    const subscription = await subscribeFileChanges((changes) => {
      if (changes.some((change) => !isCaptureSpoolPath(change.path))) {
        next.noteChanged()
      }
    })
    if (disposed || engine !== next) {
      subscription()
      next.stop()
      return false
    }
    unlisten = subscription
    // Quit-time commit (local only — never a network push on the way out).
    setBackupFlusher(async () => {
      await gitCommitAll('Update notes', generation)
    })
    return true
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
  async function startLocalHistory(initialized: boolean): Promise<void> {
    // Real git on a real folder — a shell capability the browser-dev bridge
    // honestly lacks, so don't start (and noisily fail) the commit loop there.
    if (isMobileSurface() || !isNativeShell()) {
      return
    }
    try {
      if (!initialized) {
        await gitSetup(null, null, generation)
      }
      const next = createSyncEngine({
        generation,
        localOnly: true,
        getCredential: async () => null,
        onStatus: (engineStatus) => {
          // No UI surfaces local history, so a failing commit loop (disk full,
          // corrupted repo) must at least leave a trace for diagnosis.
          if (engineStatus.state === 'error') {
            console.error('local history commit failed:', engineStatus.message)
          }
        },
      })
      if (!(await adoptEngine(next))) {
        return
      }
      void next.syncNow() // first snapshot: commit whatever is already pending
    } catch (error) {
      // `adoptEngine` assigns the engine before its first await, so a
      // half-built lifecycle takes the same teardown as every other failure.
      // No zombie engine keeps timers alive behind the caller's state.
      teardown()
      console.error('local history failed to start:', errorMessage(error))
    }
  }

  async function start(): Promise<void> {
    teardown()
    if (disposed) {
      return
    }
    setState({ phase: 'loading' })
    try {
      const [status, auth] = await Promise.all([
        gitStatus(generation),
        // A keychain the app can't read is indistinguishable from a signed-out
        // one as far as backup is concerned, and must not cost the graph its
        // history: degrade to the signed-out path below rather than failing
        // the whole start into the engine-less catch.
        loadGithubAuth().catch((error: unknown) => {
          console.error('reading the GitHub credential failed:', errorMessage(error))
          return null
        }),
      ])
      if (disposed) {
        return
      }
      if (!status.initialized || status.remoteUrl === null) {
        setState({ phase: 'disconnected' })
        await startLocalHistory(status.initialized)
        return
      }
      const remoteUrl = status.remoteUrl
      const repo = parseGithubRemote(remoteUrl)
      if (repo !== null && auth === null) {
        // A GitHub remote needs the managed sign-in; the wizard is the fix.
        // Generic remotes adopt without it — their credentials live with the
        // user's own git tooling (ssh agent), not in our keychain.
        setState({ phase: 'disconnected' })
        await startLocalHistory(status.initialized)
        return
      }
      // Adoption only asks *whether* a credential exists; the engine resolves
      // it fresh each cycle below, so re-entering one takes effect without a
      // restart.
      const hasGitCredential =
        repo === null &&
        (await loadGitCredential(remoteUrl).catch((error: unknown) => {
          // Same degradation as the GitHub read above: an unreadable keychain
          // lands on the needs-a-credential state, not the engine-less catch.
          console.error('reading the git host credential failed:', errorMessage(error))
          return null
        })) !== null
      if (disposed) {
        return
      }
      if (repo === null && !hasGitCredential && remoteCredentialOrigin(remoteUrl) !== null) {
        // An HTTPS host we hold no credential for. Fail at adoption, not at
        // the first push: a *public* HTTPS remote would pull anonymously and
        // only 401 on push — the other device's edits arriving while this
        // one's silently never leave. The engine never starts; `rejected` =
        // acting (not retrying) is the fix. With a credential stored we
        // adopt, and a bad one surfaces as an ordinary auth error instead.
        setState({
          phase: 'connected',
          remoteUrl,
          repo: null,
          status: {
            state: 'error',
            errorKind: 'rejected',
            message:
              'This host needs a username and access token, or switch the remote to its SSH form: git remote set-url origin git@<host>:<owner>/<repo>.git',
          },
        })
        await startLocalHistory(status.initialized)
        return
      }
      const next = createSyncEngine({
        generation,
        ...(isMobileSurface() ? { idleMs: MOBILE_IDLE_MS } : {}),
        // iOS can suspend us at any await. Do not begin a launch, online, or
        // debounced Git cycle after the document is hidden; the existing
        // visible/focus trigger below replays a full cycle on foreground.
        // The background flusher's protected local commit bypasses this
        // engine deliberately.
        canStartCycle: () => !isMobileSurface() || document.visibilityState !== 'hidden',
        // Resolved against the *current* origin each cycle, not the URL
        // captured above: Rust fetches and pushes whatever origin is now, so
        // a remote re-pointed mid-session — github.com to another host, or
        // https to http — must not inherit the credential of the old one.
        getCredential: async () => {
          const current = (await gitStatus(generation)).remoteUrl
          if (current === null) {
            return null
          }
          if (parseGithubRemote(current) !== null) {
            // A null token is "signed out" — the engine turns that into the
            // same auth state it always did, not a silent no-auth push.
            const token = await getGithubToken(providerFetch)
            return token === null ? null : githubCredential(token)
          }
          return await loadGitCredential(current)
        },
        onStatus: (engineStatus) => {
          setState({ phase: 'connected', remoteUrl, repo, status: engineStatus })
        },
        onLargeFilesSkipped: (files) => {
          // Surface the guardrail loudly: these files are NOT in the backup.
          const names = files.map((file) => file.path).join(', ')
          startOperation('Backing up').fail(`Too large to back up (kept local): ${names}`)
        },
        onRemoteChanges,
      })
      setState({ phase: 'connected', remoteUrl, repo, status: { state: 'idle' } })
      if (!(await adoptEngine(next))) {
        return
      }

      domDisposers.push(attachResumeListeners(() => void next.syncNow()))

      void next.syncNow() // launch pull: pick up other devices' changes
    } catch (error) {
      // Any partially-built lifecycle is torn down whole — no zombie engine
      // keeps timers or git work running behind a disconnected UI.
      teardown()
      if (!disposed) {
        console.error('backup start failed:', errorMessage(error))
        setState({ phase: 'disconnected' })
      }
    }
  }

  async function requireToken(): Promise<string> {
    const token = await getGithubToken(providerFetch)
    if (token === null) {
      throw new ReflectError('auth', 'Connect GitHub first (no credential stored)')
    }
    return token
  }

  /**
   * Point `origin` at `remoteUrl` and restart. The engine stops first: a cycle
   * resolves its credential once, so one still running when `origin` moves
   * would send its next command — with the old remote's credential — to the
   * new host. start() runs whatever happens, so a failed setup brings the old
   * engine back instead of leaving backup silently stopped.
   */
  async function connectRemote(
    remoteUrl: string,
    branch: string | null,
    afterSetup?: () => Promise<void>,
  ): Promise<void> {
    teardown()
    try {
      await gitSetup(remoteUrl, branch, generation)
      await afterSetup?.()
    } finally {
      await start()
    }
  }

  return {
    start,
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    connectNewRepo: async (name) => {
      const token = await requireToken()
      const repo = await createGithubRepo(token, name, { isPrivate: true, fetchFn: providerFetch })
      if (repo === null) {
        return 'manualCreateNeeded' // fine-grained PATs can't create repos
      }
      const [owner, repoName, ...rest] = repo.fullName.split('/')
      if (owner === undefined || repoName === undefined || rest.length > 0) {
        throw new ReflectError('parse', `unexpected repository name from GitHub: ${repo.fullName}`)
      }
      // Align with the account's default branch for new repos so the first
      // push creates the branch GitHub already considers the default.
      await connectRemote(githubRemoteUrl({ owner, name: repoName }), repo.defaultBranch)
      return 'connected'
    },
    connectExistingRepo: async (ref, connectOptions = {}) => {
      const token = await requireToken()
      const repo = await getGithubRepo(token, ref, providerFetch)
      if (repo === null) {
        return 'notFound'
      }
      if (!repo.isPrivate && connectOptions.allowPublic !== true) {
        return 'needsPublicConfirm'
      }
      // The repo's default branch is where its existing backup history lives —
      // the local branch must match or sync would fork a parallel branch.
      await connectRemote(githubRemoteUrl(ref), repo.defaultBranch)
      return 'connected'
    },
    connectHostRemote: async (remoteUrl, credential) => {
      // Every input is checked before origin moves, so a bad one leaves the
      // graph exactly as it was.
      const origin = remoteCredentialOrigin(remoteUrl)
      if (origin === null) {
        throw new ReflectError('parse', `not an http(s) remote: ${remoteUrl}`)
      }
      if (new URL(origin).hostname === 'github.com') {
        // By host, not by URL text, so no spelling slips past. start() routes
        // github.com to the managed sign-in, so a token stored for it here
        // would never be read.
        throw new ReflectError(
          'parse',
          'github.com remotes use the GitHub sign-in — connect GitHub instead',
        )
      }
      if (!isValidGitCredential(credential)) {
        throw new ReflectError('parse', 'a username and access token are both required')
      }
      // Remote first, so a failed setup stores nothing; credential before
      // start(), which is what reads it. The entry is per host, shared by
      // every graph on it — saving replaces the one they use.
      await connectRemote(remoteUrl, null, () => saveGitCredential(remoteUrl, credential))
    },
    disconnectGraph: async () => {
      await gitDisconnect(generation)
      await start()
    },
    signOut: async () => {
      await clearGithubAuth()
      invalidateGithubAuth()
      await start()
    },
    backUpNow: async () => {
      await engine?.syncNow()
    },
    dispose: () => {
      disposed = true
      teardown()
      listeners.clear()
    },
  }
}
