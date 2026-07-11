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
  loadGithubAuth,
  parseGithubRemote,
  ReflectError,
  subscribeFileChanges,
  type ChangedFile,
  type GithubRepoRef,
  type GraphInfo,
  type SyncEngine,
  type SyncStatus,
  type Unlisten,
} from '@reflect/core'
import { setBackupFlusher } from '@/lib/backup-flush'
import { invalidateGithubAuth } from '@/lib/github-auth-state'
import { startOperation } from '@/lib/operations'
import { isMobileSurface } from '@/lib/platform-surface'
import { providerFetch } from '@/lib/provider-fetch'
import { throttledInvalidateIndexQueries } from '@/lib/query-client'

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
 * A single foreground/resume transition fires several DOM events at once —
 * WKWebView emits both `visibilitychange` and `focus` on app resume, desktop
 * unminimize can too. Each would queue its own full engine cycle (single
 * flight queues a *follow-up*, it doesn't drop the second call), doubling
 * the network work of every resume; triggers inside this window collapse
 * into one cycle.
 */
const RESUME_SYNC_DEDUPE_MS = 1500

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
   * Stop backing **this graph** up (drops its remote; history and the
   * machine-level GitHub credential stay — other graphs keep syncing).
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

  function setState(next: BackupState): void {
    if (disposed) {
      return
    }
    state = next
    for (const listener of [...listeners]) {
      listener()
    }
  }

  /** The single teardown path — every exit (failure, dispose, restart) takes it. */
  function teardown(): void {
    engine?.stop()
    engine = null
    unlisten?.()
    unlisten = null
    for (const dispose of domDisposers.splice(0)) {
      dispose()
    }
    setBackupFlusher(null)
  }

  async function onRemoteChanges(changes: ChangedFile[]): Promise<void> {
    if (changes.length === 0) {
      return
    }
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
      // Awaited so sync only reports idle once pulled notes are indexed —
      // but a failure here must not fail the cycle: the index is a
      // rebuildable projection (the reconcile scan heals it), while the
      // cycle's remaining work pushes the user's markdown. Markdown backup
      // never waits on projection health.
      try {
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
      } catch (cause) {
        console.error('pulled-note direct index apply failed:', cause)
      }
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
   * Local history (desktop only): a graph with no remote still gets a
   * repository and the debounced commit loop, so every edit lands in Git
   * history and stays revertable — nothing is ever fetched or pushed, and
   * the UI stays `disconnected`. Connecting a backup later adopts this
   * repository, history included.
   */
  async function startLocalHistory(initialized: boolean): Promise<void> {
    if (isMobileSurface()) {
      return
    }
    if (!initialized) {
      await gitSetup(null, null, generation)
    }
    const next = createSyncEngine({
      generation,
      localOnly: true,
      getToken: async () => null,
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
  }

  async function start(): Promise<void> {
    teardown()
    if (disposed) {
      return
    }
    setState({ phase: 'loading' })
    try {
      const [status, auth] = await Promise.all([gitStatus(generation), loadGithubAuth()])
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
        return
      }
      if (repo === null && /^https?:\/\//i.test(remoteUrl)) {
        // Plan 16 V1 speaks SSH (and paths) to generic hosts, not HTTPS.
        // Fail at adoption, not at the first push: a *public* HTTPS remote
        // would pull anonymously and only 401 on push — the other device's
        // edits arriving while this one's silently never leave. The engine
        // never starts; `rejected` = acting (not retrying) is the fix.
        setState({
          phase: 'connected',
          remoteUrl,
          repo: null,
          status: {
            state: 'error',
            errorKind: 'rejected',
            message:
              'HTTPS isn’t supported for this host yet — switch the remote to its SSH form: git remote set-url origin git@<host>:<owner>/<repo>.git',
          },
        })
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
        canStartCycle: () =>
          !isMobileSurface() || document.visibilityState !== 'hidden',
        // The managed token is for github.com only — a generic host must
        // never receive it. Rust resolves generic credentials locally.
        getToken: repo === null ? async () => null : () => getGithubToken(providerFetch),
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

      // Resume triggers: window focus (desktop refocus) and visibility →
      // visible (mobile app resume; desktop unminimize, which doesn't
      // reliably fire `focus`). Deduped — see RESUME_SYNC_DEDUPE_MS.
      let lastResumeSyncAt = 0
      const onResume = (): void => {
        const now = Date.now()
        if (now - lastResumeSyncAt < RESUME_SYNC_DEDUPE_MS) {
          return
        }
        lastResumeSyncAt = now
        void next.syncNow()
      }
      const onVisibilityChange = (): void => {
        if (document.visibilityState === 'visible') {
          onResume()
        }
      }
      const onOnline = (): void => {
        void next.syncNow() // the `offline` state's recovery trigger
      }
      window.addEventListener('focus', onResume)
      document.addEventListener('visibilitychange', onVisibilityChange)
      window.addEventListener('online', onOnline)
      domDisposers.push(
        () => window.removeEventListener('focus', onResume),
        () => document.removeEventListener('visibilitychange', onVisibilityChange),
        () => window.removeEventListener('online', onOnline),
      )

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

  async function connectRemote(remoteUrl: string, branch: string): Promise<void> {
    await gitSetup(remoteUrl, branch, generation)
    await start()
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
