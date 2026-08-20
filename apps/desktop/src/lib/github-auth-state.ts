import { queryClient, queryKeys } from '@/lib/query-client'

/**
 * The query key for "is a GitHub credential stored on this machine" — read by
 * `useGithubConnected`. Queries cache forever (`staleTime: Infinity`), so
 * every place the credential changes must signal here, exactly like the
 * index-change invalidation.
 */
/** Refetch GitHub-connection state; call after the credential is saved or cleared. */
export function invalidateGithubAuth(): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.github.authentication })
}
