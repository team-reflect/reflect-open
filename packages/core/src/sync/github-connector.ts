import { AppError, isAppError } from '../errors.ts'
import type { SyncStatus } from './engine.ts'
import type { GitSyncService } from './git-sync-service.ts'
import type { GithubAuthService } from './github-auth-service.ts'
import type { GithubRepoRef, GithubRepoService } from './github-repo-service.ts'
import { githubRemoteUrl } from './remote-url.ts'

/**
 * Outcome of connecting to an existing repo (the public case needs consent).
 */
export type ConnectExistingResult = 'connected' | 'needsPublicConfirm' | 'notFound'

/**
 * Connects the open graph to a GitHub repository through the REST API and
 * the GitHub account: the one place the sync domain speaks GitHub.
 */
export interface GithubConnector {
  /**
   * Create a new **private** repo for the signed-in user and connect it.
   * `manualCreateNeeded` means the token *type* can't create repositories
   * (fine-grained PATs can't call `POST /user/repos`) — the dialog falls
   * back to the prefilled github.com/new handoff and connects afterwards.
   */
  connectNewRepo(name: string): Promise<'connected' | 'manualCreateNeeded'>
  /**
   * Connect an existing repo. A public repo returns `needsPublicConfirm`
   * unless `allowPublic` — everything in the graph (including `private:
   * true` notes) would be world-readable, so that needs an explicit yes.
   */
  connectExistingRepo(
    ref: GithubRepoRef,
    options?: { allowPublic?: boolean | undefined },
  ): Promise<ConnectExistingResult>
}

export interface GithubConnectorDeps {
  readonly githubAuth: GithubAuthService
  readonly githubRepos: GithubRepoService
  readonly gitSync: Pick<GitSyncService, 'connectRemote'>
}

class GithubConnectorImpl implements GithubConnector {
  readonly #deps: GithubConnectorDeps

  constructor(deps: GithubConnectorDeps) {
    this.#deps = deps
  }

  async connectNewRepo(name: string): Promise<'connected' | 'manualCreateNeeded'> {
    const { githubRepos, gitSync } = this.#deps
    const token = await this.#requireToken()
    const repo = await githubRepos.createRepo(token, name, { isPrivate: true })
    if (repo === null) {
      return 'manualCreateNeeded' // fine-grained PATs can't create repos
    }
    const [owner, repoName, ...rest] = repo.fullName.split('/')
    if (owner === undefined || repoName === undefined || rest.length > 0) {
      throw new AppError('parse', `unexpected repository name from GitHub: ${repo.fullName}`)
    }
    // Align with the account's default branch for new repos so the first
    // push creates the branch GitHub already considers the default.
    await gitSync.connectRemote(githubRemoteUrl({ owner, name: repoName }), repo.defaultBranch)
    return 'connected'
  }

  async connectExistingRepo(
    ref: GithubRepoRef,
    connectOptions: { allowPublic?: boolean | undefined } = {},
  ): Promise<ConnectExistingResult> {
    const { githubRepos, gitSync } = this.#deps
    const token = await this.#requireToken()
    const repo = await githubRepos.getRepo(token, ref)
    if (repo === null) {
      return 'notFound'
    }
    if (!repo.isPrivate && connectOptions.allowPublic !== true) {
      return 'needsPublicConfirm'
    }
    // The repo's default branch is where its existing history lives — the
    // local branch must match or sync would fork a parallel branch.
    await gitSync.connectRemote(githubRemoteUrl(ref), repo.defaultBranch)
    return 'connected'
  }

  async #requireToken(): Promise<string> {
    const token = await this.#deps.githubAuth.getToken()
    if (token === null) {
      throw new AppError('auth', 'Sign in to GitHub first (no credential stored)')
    }
    return token
  }
}

export function createGithubConnector(deps: GithubConnectorDeps): GithubConnector {
  return new GithubConnectorImpl(deps)
}

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
      message: 'GitHub is rate limiting or unreachable; the sync will retry',
    }
  }
}
