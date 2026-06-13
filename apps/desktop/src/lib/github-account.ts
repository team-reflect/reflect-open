import {
  clearGithubAuth,
  getAuthenticatedUser,
  getGithubToken,
  isAppError,
  loadGithubAuth,
  type GithubAuth,
  type GithubUser,
} from '@reflect/core'
import { invalidateGithubAuth } from '@/lib/github-auth-state'
import { providerFetch } from '@/lib/provider-fetch'

/** The token a stored credential would supply right now (no refresh). */
function usableToken(auth: GithubAuth): string {
  return auth.kind === 'pat' ? auth.token : auth.accessToken
}

/**
 * The machine-level GitHub identity (not graph-scoped, unlike the backup
 * controller): resolves the stored credential to who it belongs to via
 * `GET /user`. Doubles as token validation — the connect flow calls this
 * right after a credential is stored so a mistyped token fails at entry
 * ("GitHub rejected the token") instead of minutes later at the first sync.
 *
 * Returns `null` when no credential is stored. A credential GitHub rejects
 * is **cleared** before the auth error is rethrown — keeping it would make
 * every later flow skip the sign-in step and fail somewhere worse. The
 * clear is conditional on the keychain still holding the token GitHub
 * actually rejected: a slow rejection of an old credential (the auth step
 * probes on mount) must not wipe a newer one saved while it was in flight.
 */
export async function fetchSignedInUser(): Promise<GithubUser | null> {
  const token = await getGithubToken(providerFetch)
  if (token === null) {
    return null
  }
  try {
    return await getAuthenticatedUser(token, providerFetch)
  } catch (error: unknown) {
    if (isAppError(error) && error.kind === 'auth') {
      const current = await loadGithubAuth()
      if (current !== null && usableToken(current) === token) {
        await clearGithubAuth()
        invalidateGithubAuth()
      }
    }
    throw error
  }
}
