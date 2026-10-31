import { useEffect } from 'react'
import { useCoreServices } from '@/services/services-provider.tsx'
import { useServiceState } from '@/services/use-service-state.ts'

/**
 * Whether a GitHub credential is stored on this machine (keychain presence,
 * not validity — a dead token surfaces at use time with its real error).
 * Gates GitHub-only affordances like private-link sharing; machine-level.
 * False until the first keychain read answers.
 */
export function useGithubConnected(): boolean {
  const { githubAuth, logger } = useCoreServices()
  const { connected } = useServiceState(githubAuth, githubAuth.getState)

  useEffect(() => {
    if (githubAuth.getState().connected !== null) {
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
