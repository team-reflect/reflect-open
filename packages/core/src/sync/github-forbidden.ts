import { isAppError } from '../errors.ts'
import type { SyncStatus } from './engine.ts'
import type { GithubAuthService } from './github-auth-service.ts'
import type { GithubRepoRef } from './types.ts'

/**
 * GitHub answers 403 both for a token without access to the repository
 * and for rate limiting. libgit2 cannot tell either from a bad token, so
 * the engine reports `auth` and the UI offers "sign in again", which fixes
 * neither. Ask GitHub whether the token itself is good: when it is, the
 * push was refused for another reason and the status names it. `null`
 * means the credential really is bad, or nobody is signed in: `auth` stands.
 */
export async function classifyForbiddenStatus(
  githubAuth: GithubAuthService,
  repo: GithubRepoRef,
): Promise<SyncStatus | null> {
  try {
    const token = await githubAuth.getToken()
    if (token === null) {
      return null
    }
    await githubAuth.getAuthenticatedUser(token)
    return {
      state: 'error',
      errorKind: 'rejected',
      message: `GitHub refused the sync (403). Check that Reflect has access to ${repo.owner}/${repo.name}, or wait a few minutes if GitHub is rate limiting.`,
    }
  } catch (cause) {
    // A rejected probe confirms the bad credential. Anything else (GitHub
    // throttling, a fetch that never reached it, an unparsable reply) says
    // nothing about the credential, so it must not keep asking for a
    // sign-in either.
    if (isAppError(cause) && cause.kind === 'auth') {
      return null
    }
    return {
      state: 'offline',
      message: 'GitHub is rate limiting or unreachable; the backup will retry',
    }
  }
}
