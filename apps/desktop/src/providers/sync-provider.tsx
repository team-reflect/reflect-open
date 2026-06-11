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
import { ReflectError, type GithubRepoRef, type GraphInfo } from '@reflect/core'
import {
  createBackupController,
  type BackupController,
  type BackupState,
  type ConnectExistingResult,
} from '@/lib/backup-controller'
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
    const next = createBackupController({ graph, indexGeneration })
    setController(next)
    void next.start()
    return () => {
      next.dispose()
      setController((current) => (current === next ? null : current))
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
