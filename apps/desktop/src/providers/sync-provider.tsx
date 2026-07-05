import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react'
import { hasBridge, ReflectError, type GithubRepoRef, type GraphInfo } from '@reflect/core'
import {
  createBackupController,
  type BackupController,
  type BackupState,
  type ConnectExistingResult,
} from '@/lib/backup-controller'
import { createIcloudController, isICloudRoot } from '@/lib/icloud-controller'
import { isMobileSurface } from '@/lib/platform-surface'
import { isMainWindow } from '@/lib/window-role'
import { useGraph } from '@/providers/graph-provider'

export type { BackupState, ConnectExistingResult } from '@/lib/backup-controller'

interface SyncContextValue {
  backup: BackupState
  /** `manualCreateNeeded` = the token type can't create repos (guide instead). */
  connectNewRepo: (name: string) => Promise<'connected' | 'manualCreateNeeded'>
  connectExistingRepo: (
    ref: GithubRepoRef,
    options?: { allowPublic?: boolean },
  ) => Promise<ConnectExistingResult>
  /** Stop backing this graph up (other graphs and the credential stay). */
  disconnectGraph: () => Promise<void>
  /** Sign the machine out of GitHub (every connected graph stops syncing). */
  signOut: () => Promise<void>
  backUpNow: () => Promise<void>
}

const SyncContext = createContext<SyncContextValue | null>(null)

const LOADING: BackupState = { phase: 'loading' }

interface SyncProviderProps {
  graph: GraphInfo
  children: ReactNode
}

/**
 * Thin React shim over the {@link createBackupController} lifecycle (Plan
 * 12): one controller per (graph, index session), created and disposed by an
 * effect, surfaced through `useSyncExternalStore`. All sync behavior lives in
 * the controller — this component owns nothing but the mounting.
 */
export function SyncProvider({ graph, children }: SyncProviderProps): ReactElement {
  const { indexGeneration } = useGraph()
  const [controller, setController] = useState<BackupController | null>(null)

  useEffect(() => {
    // One backup controller per app: a secondary note window mounting a
    // second one would race commits/pulls against the main window's. Its
    // sync state stays 'loading' — the note window edits, main syncs.
    if (!isMainWindow()) {
      return
    }
    const next = createBackupController({ graph, indexGeneration })
    // The controller is an imperative lifecycle object created per (graph, index
    // session); it must be instantiated in an effect (it subscribes and starts)
    // and stored so useSyncExternalStore can read it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setController(next)
    void next.start()
    return () => {
      next.dispose()
      setController((current) => (current === next ? null : current))
    }
  }, [graph, indexGeneration])

  // iCloud-hosted graphs additionally get the conflict lifecycle (Plan 21):
  // the metadata-query watch, debounced conflict sweeps, and shadow-base
  // bookkeeping. Same per-(graph, index session) shape as the backup
  // controller; a graph outside iCloud mounts nothing.
  useEffect(() => {
    if (!hasBridge() || !isICloudRoot(graph.root) || !isMainWindow()) {
      return
    }
    const icloud = createIcloudController({
      graph,
      indexGeneration,
      emitFileChangesFromWatch: isMobileSurface(),
    })
    void icloud.start()
    return () => {
      icloud.dispose()
    }
  }, [graph, indexGeneration])

  const backup = useSyncExternalStore(
    controller?.subscribe ?? (() => () => {}),
    controller?.getState ?? (() => LOADING),
  )

  const value = useMemo<SyncContextValue>(() => {
    const require = (): BackupController => {
      if (controller === null) {
        throw new ReflectError('io', 'backup is still initializing')
      }
      return controller
    }
    return {
      backup,
      connectNewRepo: (name) => require().connectNewRepo(name),
      connectExistingRepo: (ref, options) => require().connectExistingRepo(ref, options),
      disconnectGraph: () => require().disconnectGraph(),
      signOut: () => require().signOut(),
      backUpNow: () => require().backUpNow(),
    }
  }, [controller, backup])

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>
}

/** Backup state + actions; must be used under a {@link SyncProvider}. */
export function useSync(): SyncContextValue {
  const value = useContext(SyncContext)
  if (value === null) {
    throw new Error('useSync must be used within a SyncProvider')
  }
  return value
}

/**
 * Like {@link useSync}, but `null` outside a provider. For surfaces that also
 * render where no backup lifecycle is mounted — the mobile settings sheet in
 * the plain-browser dev harness and in screen tests — and degrade by hiding
 * their sync rows instead of crashing.
 */
export function useSyncContext(): SyncContextValue | null {
  return useContext(SyncContext)
}
