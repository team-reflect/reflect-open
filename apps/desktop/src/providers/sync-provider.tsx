import { useMemo } from 'react'
import {
  AppError,
  type GithubConnector,
  type GitSyncService,
  type GitSyncState,
  type GitHostConnector,
  type Store,
} from '@reflect/core'
import { useStore } from '@/lib/use-store.ts'
import { useMaybeGraphServices } from '@/services/services-provider.tsx'

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
export function useGitSyncStore(): Store<GitSyncState> {
  return useMaybeGraphServices()?.gitSync ?? NO_GIT_SYNC
}

/**
 * The whole value of {@link useGitSyncStore}.
 */
export function useGitSyncState(): GitSyncState {
  return useStore(useGitSyncStore())
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
