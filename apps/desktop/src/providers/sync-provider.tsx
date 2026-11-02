import { useMemo } from 'react'
import { getMobileSyncStatus, type MobileSyncStatus } from '@reflect/app'
import {
  AppError,
  type GithubConnector,
  type GitSyncService,
  type GitSyncState,
  type GitHostConnector,
  type Store,
} from '@reflect/core'
import { isDeepEqual } from '@ocavue/utils'
import { useSelector, useStore } from '@/lib/use-store.ts'
import { useMaybeGraphServices } from '@/services/services-provider.tsx'

type SyncStatus = Extract<GitSyncState, { phase: 'connected' }>['status']

type GitSyncActions = Pick<GitSyncService, 'disconnectGraph' | 'syncNow'> &
  Pick<GithubConnector, 'connectNewRepo' | 'connectExistingRepo'> &
  Pick<GitHostConnector, 'connectGitHost' | 'updateGitHostSignIn'>

const LOADING: GitSyncState = { phase: 'loading' }

/**
 * What the surface reads where the graph runs no git sync service.
 */
const NO_GIT_SYNC: Store<GitSyncState> = {
  subscribe: () => () => {},
  get: () => LOADING,
}

/**
 * The git sync state of the open graph's `GitSyncService`. A note window runs
 * none: its state stays 'loading' (the note window edits, main syncs).
 */
function useGitSyncStore(): Store<GitSyncState> {
  return useMaybeGraphServices()?.gitSync ?? NO_GIT_SYNC
}

function selectGitSyncConnected(state: GitSyncState): boolean {
  return state.phase === 'connected'
}

function selectGitSyncStatus(state: GitSyncState): SyncStatus | null {
  return state.phase === 'connected' ? state.status : null
}

/**
 * The whole value of {@link useGitSyncStore}.
 */
export function useGitSyncState(): GitSyncState {
  return useStore(useGitSyncStore())
}

/**
 * Whether the graph's git sync is connected to a remote.
 */
export function useGitSyncConnected(): boolean {
  return useSelector(useGitSyncStore(), selectGitSyncConnected)
}

/**
 * The sync cycle status of a connected graph, or `null` when it is not connected.
 */
export function useGitSyncStatus(): SyncStatus | null {
  return useSelector(useGitSyncStore(), selectGitSyncStatus)
}

/**
 * The mobile sync status: its label, tone, and detail.
 */
export function useMobileSyncStatus(): MobileSyncStatus | null {
  return useSelector(useGitSyncStore(), getMobileSyncStatus, isDeepEqual)
}

/**
 * The actions of the open graph's `GitSyncService` and its connectors. They
 * throw where the graph runs no git sync service.
 */
export function useGitSyncActions(): GitSyncActions {
  const graph = useMaybeGraphServices()
  const controller = graph?.gitSync ?? null
  const githubConnector = graph?.githubConnector ?? null
  const gitHostConnector = graph?.gitHostConnector ?? null

  return useMemo<GitSyncActions>(() => {
    const require = <Service,>(service: Service | null): Service => {
      if (service === null) {
        throw new AppError('io', 'git sync is still initializing')
      }
      return service
    }
    return {
      connectNewRepo: (name) => require(githubConnector).connectNewRepo(name),
      connectExistingRepo: (ref, options) => {
        return require(githubConnector).connectExistingRepo(ref, options)
      },
      connectGitHost: (input) => require(gitHostConnector).connectGitHost(input),
      updateGitHostSignIn: (input) => require(gitHostConnector).updateGitHostSignIn(input),
      disconnectGraph: () => require(controller).disconnectGraph(),
      syncNow: () => require(controller).syncNow(),
    }
  }, [controller, githubConnector, gitHostConnector])
}
