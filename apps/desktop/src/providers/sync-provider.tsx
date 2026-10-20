import { useMemo } from 'react'
import { AppError, type GitSyncService, type GitSyncState } from '@reflect/core'
import { useMaybeGraphServices } from '@/services/services-provider.tsx'
import { useServiceState } from '@/services/use-service-state.ts'

export type { GitSyncState, ConnectExistingResult } from '@reflect/core'

type GitSyncContextValue = { state: GitSyncState } & Pick<
  GitSyncService,
  'connectNewRepo' | 'connectExistingRepo' | 'disconnectGraph' | 'signOut' | 'syncNow'
>

const LOADING: GitSyncState = { phase: 'loading' }

/**
 * What the surface reads where the graph runs no git sync service.
 */
const NO_GIT_SYNC = {
  subscribe: () => () => {},
  getState: (): GitSyncState => LOADING,
}

/**
 * Git sync state + actions of the open graph's `GitSyncService`. A note window
 * runs none: its state stays 'loading' (the note window edits, main syncs).
 */
export function useGitSync(): GitSyncContextValue {
  const controller = useMaybeGraphServices()?.gitSync ?? null
  const store = controller ?? NO_GIT_SYNC
  const state = useServiceState(store, store.getState)

  return useMemo<GitSyncContextValue>(() => {
    const require = (): GitSyncService => {
      if (controller === null) {
        throw new AppError('io', 'backup is still initializing')
      }
      return controller
    }
    return {
      state,
      connectNewRepo: (name) => require().connectNewRepo(name),
      connectExistingRepo: (ref, options) => require().connectExistingRepo(ref, options),
      disconnectGraph: () => require().disconnectGraph(),
      signOut: () => require().signOut(),
      syncNow: () => require().syncNow(),
    }
  }, [controller, state])
}

/**
 * Like {@link useGitSync}, but `null` where the graph runs no git sync service:
 * no graph session is open (the mobile settings sheet in the plain-browser
 * dev harness and in screen tests), and those surfaces hide their sync rows.
 */
export function useGitSyncContext(): GitSyncContextValue | null {
  const sync = useGitSync()
  const gitSync = useMaybeGraphServices()?.gitSync ?? null
  return gitSync === null ? null : sync
}
