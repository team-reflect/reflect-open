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
import { startOperation } from '@/lib/operations'
import { providerFetch } from '@/lib/provider-fetch'
import { invalidateIndexQueries } from '@/lib/query-client'

/**
 * Backup state as the UI sees it. `connected` means the graph has a repo,
 * an `origin` remote, and a stored GitHub credential — the engine is running.
 */
export type BackupState =
  | { phase: 'loading' }
  | { phase: 'disconnected' }
  | { phase: 'connected'; remoteUrl: string; repo: GithubRepoRef | null; status: SyncStatus }

/** Outcome of connecting to an existing repo (the public case needs consent). */
export type ConnectExistingResult = 'connected' | 'needsPublicConfirm' | 'notFound'

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
 * feeds its debounce, window focus/online listeners (launch, focus, and
 * back-online pulls), the quit-commit hook, and the connect / disconnect /
 * sign-out / back-up-now actions.
 */
export interface BackupController {
  /** Probe the graph and start the engine if fully connected. Idempotent. */
  start(): Promise<void>
  getState(): BackupState
  /** Subscribe to state changes; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
  /** Create a new **private** repo for the signed-in user and connect it. */
  connectNewRepo(name: string): Promise<void>
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

/** Pull-changed paths the index tracks (mirrors the watcher's filter). */
function isIndexablePath(path: string): boolean {
  return (path.startsWith('daily/') || path.startsWith('notes/')) && path.endsWith('.md')
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

  function onRemoteChanges(changes: ChangedFile[]): void {
    const indexable = changes.filter((change) => isIndexablePath(change.path))
    if (indexable.length === 0) {
      return
    }
    // Pull-applied writes must not depend on the file watcher being up (the
    // launch pull can land before watch start), so both consumers are
    // notified directly: open editors via the local file-changes channel —
    // an unnotified open note would overwrite the merged content on its next
    // save — and the index via a direct apply (idempotent if a live watcher
    // subscription double-applies).
    emitFileChanges(indexable)
    if (indexGeneration !== null) {
      void applyIndexChanges(indexable, indexGeneration).then(invalidateIndexQueries)
    }
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
      if (!status.initialized || status.remoteUrl === null || auth === null) {
        setState({ phase: 'disconnected' })
        return
      }
      const remoteUrl = status.remoteUrl
      const repo = parseGithubRemote(remoteUrl)
      const next = createSyncEngine({
        generation,
        getToken: () => getGithubToken(providerFetch),
        onStatus: (engineStatus) => {
          setState({ phase: 'connected', remoteUrl, repo, status: engineStatus })
        },
        onLargeFilesSkipped: (files) => {
          // Surface the guardrail loudly: these files are NOT in the backup.
          const names = files.map((file) => file.path).join(', ')
          startOperation('Backing up').fail(`Too large for GitHub backup (kept local): ${names}`)
        },
        onRemoteChanges,
      })
      engine = next
      setState({ phase: 'connected', remoteUrl, repo, status: { state: 'idle' } })

      const subscription = await subscribeFileChanges(() => next.noteChanged())
      if (disposed || engine !== next) {
        // Teardown (or a restart) won the race against the subscribe.
        subscription()
        next.stop()
        return
      }
      unlisten = subscription

      const onFocus = (): void => {
        void next.syncNow()
      }
      const onOnline = (): void => {
        void next.syncNow() // the `offline` state's recovery trigger
      }
      window.addEventListener('focus', onFocus)
      window.addEventListener('online', onOnline)
      domDisposers.push(
        () => window.removeEventListener('focus', onFocus),
        () => window.removeEventListener('online', onOnline),
      )
      // Quit-time commit (local only — never a network push on the way out).
      setBackupFlusher(async () => {
        await gitCommitAll('Update notes', generation)
      })

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
      const [owner, repoName, ...rest] = repo.fullName.split('/')
      if (owner === undefined || repoName === undefined || rest.length > 0) {
        throw new ReflectError('parse', `unexpected repository name from GitHub: ${repo.fullName}`)
      }
      // Align with the account's default branch for new repos so the first
      // push creates the branch GitHub already considers the default.
      await connectRemote(githubRemoteUrl({ owner, name: repoName }), repo.defaultBranch)
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
