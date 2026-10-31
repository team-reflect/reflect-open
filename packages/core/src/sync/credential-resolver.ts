import type { MaybePromise } from '@reflect/utils'
import { errorMessage } from '../errors.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { GitHostCredentialService } from './git-host-credential-service.ts'
import type { GitCredential } from './git-repository-service.ts'
import { githubCredential, type GithubAuthService } from './github-auth-service.ts'
import type { GitRemote } from './remote-url.ts'

/**
 * Whether a remote can sync right now. `ready` carries the per-cycle lookup
 * the sync engine calls; `missing` means the sign-in the remote needs is not
 * stored (the GitHub account is signed out, or the host has no entry).
 */
export type ResolvedCredential =
  | { kind: 'ready'; get: () => MaybePromise<GitCredential | null> }
  | { kind: 'missing' }

/**
 * Which sign-in a remote gets. The GitHub account only ever reaches
 * `github` remotes and a git host entry only ever reaches its own origin; SSH
 * and path remotes get none, and Rust resolves them locally.
 */
export interface CredentialResolver {
  resolve(remote: GitRemote): Promise<ResolvedCredential>
}

export interface CredentialResolverDeps {
  readonly githubAuth: GithubAuthService
  readonly gitHostCredentials: GitHostCredentialService
  readonly logger: LoggerService
}

class CredentialResolverImpl implements CredentialResolver {
  readonly #deps: CredentialResolverDeps

  constructor(deps: CredentialResolverDeps) {
    this.#deps = deps
  }

  async resolve(remote: GitRemote): Promise<ResolvedCredential> {
    const { githubAuth, gitHostCredentials, logger } = this.#deps
    switch (remote.kind) {
      case 'github': {
        // A keychain the app cannot read is indistinguishable from a signed-out
        // one as far as syncing is concerned.
        const auth = await githubAuth.load().catch((error: unknown) => {
          logger.error('reading the GitHub credential failed:', errorMessage(error))
          return null
        })
        if (auth === null) {
          return { kind: 'missing' }
        }
        // Resolved per cycle so an app token refreshes under a running engine.
        return {
          kind: 'ready',
          get: async () => {
            const token = await githubAuth.getToken()
            return token === null ? null : githubCredential(token)
          },
        }
      }
      case 'https': {
        // A sign-in would travel in the clear over plain http: never offered.
        if (!remote.origin.startsWith('https:')) {
          return { kind: 'missing' }
        }
        const stored = await gitHostCredentials.load(remote.origin)
        if (stored === null) {
          return { kind: 'missing' }
        }
        // Re-read per cycle so an updated sign-in takes effect without a restart.
        return { kind: 'ready', get: () => gitHostCredentials.load(remote.origin) }
      }
      case 'ssh':
      case 'path':
        return { kind: 'ready', get: () => null }
    }
  }
}

export function createCredentialResolver(deps: CredentialResolverDeps): CredentialResolver {
  return new CredentialResolverImpl(deps)
}
