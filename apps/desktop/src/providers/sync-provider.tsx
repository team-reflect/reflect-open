import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  applyIndexChanges,
  clearGithubAuth,
  createGithubRepo,
  createSyncEngine,
  getGithubRepo,
  getGithubToken,
  githubRemoteUrl,
  gitSetup,
  gitStatus,
  loadGithubAuth,
  parseGithubRemote,
  subscribeFileChanges,
  type ChangedFile,
  type GithubRepoRef,
  type GraphInfo,
  type SyncEngine,
  type SyncStatus,
  type Unlisten,
} from '@reflect/core'
import { startOperation } from '@/lib/operations'
import { providerFetch } from '@/lib/provider-fetch'
import { invalidateIndexQueries } from '@/lib/query-client'

/** Pull-changed paths the index tracks (mirrors the watcher's filter). */
function isIndexablePath(path: string): boolean {
  return (path.startsWith('daily/') || path.startsWith('notes/')) && path.endsWith('.md')
}

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

interface SyncContextValue {
  backup: BackupState
  /** Create a new **private** repo for the signed-in user and connect it. */
  connectNewRepo: (name: string) => Promise<void>
  /**
   * Connect an existing repo. A public repo returns `needsPublicConfirm`
   * unless `allowPublic` — everything in the graph (including `private:
   * true` notes) would be world-readable, so that needs an explicit yes.
   */
  connectExistingRepo: (
    ref: GithubRepoRef,
    options?: { allowPublic?: boolean },
  ) => Promise<ConnectExistingResult>
  /** Stop backups and drop the stored GitHub credential (repo stays intact). */
  disconnect: () => Promise<void>
  /** Full cycle now: commit, pull/merge, push. */
  backUpNow: () => Promise<void>
}

const SyncContext = createContext<SyncContextValue | null>(null)

interface SyncProviderProps {
  graph: GraphInfo
  children: ReactNode
}

/**
 * Per-graph backup & sync (Plan 12): owns the sync engine's lifecycle and
 * exposes the product-state view plus the connect/disconnect actions. The
 * engine starts only when the graph is fully connected; watcher file-change
 * events feed its debounce, window focus and launch trigger full pulls.
 */
export function SyncProvider({ graph, children }: SyncProviderProps): ReactElement {
  const [backup, setBackup] = useState<BackupState>({ phase: 'loading' })
  // Bumped after connect/disconnect so the lifecycle effect re-evaluates.
  const [connectEpoch, setConnectEpoch] = useState(0)
  const engineRef = useRef<SyncEngine | null>(null)
  const generation = graph.generation

  useEffect(() => {
    let cancelled = false
    let engine: SyncEngine | null = null
    let unlisten: Unlisten | null = null
    let onFocus: (() => void) | null = null

    async function start(): Promise<void> {
      const [status, auth] = await Promise.all([gitStatus(), loadGithubAuth()])
      if (cancelled) {
        return
      }
      if (!status.initialized || status.remoteUrl === null || auth === null) {
        setBackup({ phase: 'disconnected' })
        return
      }
      const remoteUrl = status.remoteUrl
      const repo = parseGithubRemote(remoteUrl)
      engine = createSyncEngine({
        generation,
        getToken: () => getGithubToken(providerFetch),
        onStatus: (engineStatus) => {
          setBackup({ phase: 'connected', remoteUrl, repo, status: engineStatus })
        },
        onLargeFilesSkipped: (files) => {
          // Surface the guardrail loudly: these files are NOT in the backup.
          const names = files.map((file) => file.path).join(', ')
          startOperation('Backing up').fail(`Too large for GitHub backup (kept local): ${names}`)
        },
        onRemoteChanges: (changes: ChangedFile[]) => {
          // Reindex pull-applied writes directly: the launch pull can land
          // before the file watcher is running, and a watcher event for these
          // paths would only repeat work the hash check makes cheap.
          const indexable = changes.filter((change) => isIndexablePath(change.path))
          if (indexable.length > 0) {
            void applyIndexChanges(indexable, generation).then(invalidateIndexQueries)
          }
        },
      })
      engineRef.current = engine
      setBackup({ phase: 'connected', remoteUrl, repo, status: { state: 'idle' } })

      const subscription = await subscribeFileChanges(() => {
        engine?.noteChanged()
      })
      if (cancelled) {
        // Teardown won the race against the subscribe — unhook the late
        // arrival here or the index:changed handler leaks forever.
        subscription()
        return
      }
      unlisten = subscription
      onFocus = () => {
        void engine?.syncNow()
      }
      window.addEventListener('focus', onFocus)
      void engine.syncNow() // launch pull: pick up other devices' changes
    }

    void start().catch(() => {
      if (!cancelled) {
        setBackup({ phase: 'disconnected' })
      }
    })

    return () => {
      cancelled = true
      engine?.stop()
      if (engineRef.current === engine) {
        engineRef.current = null
      }
      unlisten?.()
      if (onFocus !== null) {
        window.removeEventListener('focus', onFocus)
      }
    }
  }, [generation, connectEpoch])

  const connectRemote = useCallback(
    async (remoteUrl: string, branch: string) => {
      await gitSetup(remoteUrl, branch, generation)
      setConnectEpoch((epoch) => epoch + 1)
    },
    [generation],
  )

  const requireToken = useCallback(async (): Promise<string> => {
    const token = await getGithubToken(providerFetch)
    if (token === null) {
      throw { kind: 'auth' as const, message: 'Connect GitHub first (no credential stored)' }
    }
    return token
  }, [])

  const connectNewRepo = useCallback(
    async (name: string) => {
      const token = await requireToken()
      const repo = await createGithubRepo(token, name, { isPrivate: true, fetchFn: providerFetch })
      const [owner, repoName] = repo.fullName.split('/')
      // Align with the account's default branch for new repos so the first
      // push creates the branch GitHub already considers the default.
      await connectRemote(githubRemoteUrl({ owner, name: repoName }), repo.defaultBranch)
    },
    [connectRemote, requireToken],
  )

  const connectExistingRepo = useCallback(
    async (
      ref: GithubRepoRef,
      options: { allowPublic?: boolean } = {},
    ): Promise<ConnectExistingResult> => {
      const token = await requireToken()
      const repo = await getGithubRepo(token, ref, providerFetch)
      if (repo === null) {
        return 'notFound'
      }
      if (!repo.isPrivate && options.allowPublic !== true) {
        return 'needsPublicConfirm'
      }
      // The repo's default branch is where its existing backup history lives —
      // the local branch must match or sync would create a parallel branch
      // and never integrate it.
      await connectRemote(githubRemoteUrl(ref), repo.defaultBranch)
      return 'connected'
    },
    [connectRemote, requireToken],
  )

  const disconnect = useCallback(async () => {
    await clearGithubAuth()
    setConnectEpoch((epoch) => epoch + 1)
  }, [])

  const backUpNow = useCallback(async () => {
    await engineRef.current?.syncNow()
  }, [])

  return (
    <SyncContext.Provider
      value={{ backup, connectNewRepo, connectExistingRepo, disconnect, backUpNow }}
    >
      {children}
    </SyncContext.Provider>
  )
}

/** Backup state + actions; must be used under a {@link SyncProvider}. */
export function useSync(): SyncContextValue {
  const value = useContext(SyncContext)
  if (value === null) {
    throw new Error('useSync must be used within a SyncProvider')
  }
  return value
}
