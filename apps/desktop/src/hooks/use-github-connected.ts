import type { GithubAuthState } from '@reflect/core'
import { useEffect } from 'react'
import { useCoreServices } from '@/services/services-provider.tsx'
import { useSelector } from '@/lib/use-store.ts'

function selectConnected(state: GithubAuthState): boolean | null {
  return state.connected
}

/**
 * Whether a GitHub credential is stored on this machine (keychain presence,
 * not validity — a dead token surfaces at use time with its real error).
 * Gates GitHub-only affordances like private-link sharing; machine-level.
 * False until the first keychain read answers.
 */
export function useGithubConnected(): boolean {
  const { githubAuth, logger } = useCoreServices()
  const connected = useSelector(githubAuth, selectConnected)

  useEffect(() => {
    if (githubAuth.get().connected !== null) {
      return
    }
    githubAuth
      .load()
      .catch(() => githubAuth.load())
      .catch((error: unknown) => {
        logger.error('reading the GitHub credential failed', error)
      })
  }, [githubAuth, logger])

  return connected ?? false
}
