import { useMemo } from 'react'
import {
  AppError,
  type GithubConnector,
  type GitSyncService,
  type GitSyncState,
  type HostConnector,
} from '@reflect/core'
import { useMaybeGraphServices } from '@/services/services-provider.tsx'
import { useServiceState } from '@/services/use-service-state.ts'

export type { GitSyncState, ConnectExistingResult } from '@reflect/core'

type GitSyncContextValue = { state: GitSyncState } & Pick<
  GitSyncService,
  'disconnectGraph' | 'syncNow'
> &
  Pick<GithubConnector, 'connectNewRepo' | 'connectExistingRepo'> &
  Pick<HostConnector, 'connectHost'>

const LOADING: GitSyncState = { phase: 'loading' }

/**
 * What the surface reads where the graph runs no git sync service.
 */
const NO_GIT_SYNC = {
  subscribe: () => () => {},
  getState: (): GitSyncState => LOADING,
}

/**
 * Git sync state + actions of the open graph's `GitSyncService` and its
 * connectors. A note window runs none: its state stays 'loading' (the note
 * window edits, main syncs).
 */
export function useGitSync(): GitSyncContextValue {
  const graph = useMaybeGraphServices()
  const controller = graph?.gitSync ?? null
  const githubConnector = graph?.githubConnector ?? null
  const hostConnector = graph?.hostConnector ?? null
  const store = controller ?? NO_GIT_SYNC
  const state = useServiceState(store, store.getState)

  return useMemo<GitSyncContextValue>(() => {
    const require = <Service,>(service: Service | null): Service => {
      if (service === null) {
        throw new AppError('io', 'git sync is still initializing')
      }
      return service
    }
    return {
      state,
      connectNewRepo: (name) => require(githubConnector).connectNewRepo(name),
      connectExistingRepo: (ref, options) => {
        return require(githubConnector).connectExistingRepo(ref, options)
      },
      connectHost: (input) => require(hostConnector).connectHost(input),
      disconnectGraph: () => require(controller).disconnectGraph(),
      syncNow: () => require(controller).syncNow(),
    }
  }, [controller, githubConnector, hostConnector, state])
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
