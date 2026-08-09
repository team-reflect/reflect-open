import { useQuery } from '@tanstack/react-query'
import { loadGithubAuth } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready'
import { GITHUB_AUTH_QUERY_KEY } from '@/lib/github-auth-state'

/**
 * Whether a GitHub credential is stored on this machine (keychain presence,
 * not validity — a dead token surfaces at use time with its real error).
 * Gates GitHub-only affordances like private-link sharing; machine-level, so no
 * graph in the key. Kept fresh by `invalidateGithubAuth` from every flow that
 * saves or clears the credential.
 */
export function useGithubConnected(): boolean {
  const bridgeReady = useBridgeReady()
  const { data } = useQuery({
    queryKey: GITHUB_AUTH_QUERY_KEY,
    queryFn: async () => (await loadGithubAuth()) !== null,
    enabled: bridgeReady,
  })
  return data ?? false
}
