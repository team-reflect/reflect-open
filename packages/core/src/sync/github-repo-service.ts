import { z } from 'zod'
import type { HttpService } from '../ports/http-service.ts'
import { AppError } from '../errors.ts'
import { apiHeaders, readJson } from './github-api.ts'

export interface GithubRepoRef {
  owner: string
  name: string
}

/**
 * The description stamped on backup repos we create or prefill.
 */
export const BACKUP_REPO_DESCRIPTION = 'Reflect notes backup'

/**
 * The prefilled github.com/new URL — the universal "create the repo on the
 * user's behalf" path. `POST /user/repos` only works with classic PATs and
 * OAuth tokens, **not** fine-grained PATs.
 */
export function newRepoUrl(name: string): string {
  const params = new URLSearchParams({
    name,
    visibility: 'private',
    description: BACKUP_REPO_DESCRIPTION,
  })
  return `https://github.com/new?${params.toString()}`
}

/**
 * Parse `https://github.com/owner/repo(.git)` → ref, or `null` for any other remote.
 */
export function parseGithubRemote(url: string): GithubRepoRef | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
  if (match === null) {
    return null
  }
  return { owner: match[1]!, name: match[2]! }
}

/**
 * The host of an HTTPS remote URL (lowercase, with any port), else `null`.
 */
export function remoteHost(remoteUrl: string): string | null {
  const match = /^https?:\/\/([^/@]+@)?([^/]+)\//i.exec(
    remoteUrl.endsWith('/') ? remoteUrl : `${remoteUrl}/`,
  )
  return match === null ? null : match[2]!.toLowerCase()
}

/**
 * The canonical HTTPS remote URL for a repo (token never embedded).
 */
export function githubRemoteUrl(ref: GithubRepoRef): string {
  return `https://github.com/${ref.owner}/${ref.name}.git`
}

/**
 * Parse what a user types into a "which repository" field — `owner/name` or a
 * full GitHub URL — into a repo ref; `null` when it's neither.
 */
export function parseRepoInput(input: string): GithubRepoRef | null {
  const trimmed = input.trim()
  const fromUrl = parseGithubRemote(trimmed)
  if (fromUrl !== null) {
    return fromUrl
  }
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(trimmed)
  return match === null ? null : { owner: match[1]!, name: match[2]! }
}

/**
 * A backup-repo name suggestion from the graph name: "Alex Notes" →
 * "alex-notes-backup"; a generic fallback when the name slugs away to nothing.
 */
export function suggestRepoName(graphName: string | undefined): string {
  const slug = (graphName ?? '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
  return slug.length > 0 ? `${slug}-backup` : 'reflect-backup'
}

export interface GithubRepo {
  fullName: string
  /**
   * Backups must default private; a public repo needs explicit confirmation.
   */
  isPrivate: boolean
  defaultBranch: string
  htmlUrl: string
}

const repoResponseSchema = z.object({
  full_name: z.string(),
  private: z.boolean(),
  default_branch: z.string(),
  html_url: z.string(),
})

function toRepo(parsed: z.infer<typeof repoResponseSchema>): GithubRepo {
  return {
    fullName: parsed.full_name,
    isPrivate: parsed.private,
    defaultBranch: parsed.default_branch,
    htmlUrl: parsed.html_url,
  }
}

/**
 * The backup repository on GitHub, over its REST API.
 */
export interface GithubRepoService {
  /**
   * Create a repo for the signed-in user (private by default — the backup
   * norm). Returns `null` when the token *type* cannot create repositories.
   */
  createRepo(
    token: string,
    name: string,
    options?: { isPrivate?: boolean },
  ): Promise<GithubRepo | null>
  /**
   * Look up a repo (visibility check before connecting); `null` when missing.
   */
  getRepo(token: string, ref: GithubRepoRef): Promise<GithubRepo | null>
}

export interface GithubRepoServiceDeps {
  readonly http: HttpService
}

class GithubRepoServiceImpl implements GithubRepoService {
  readonly #deps: GithubRepoServiceDeps

  constructor(deps: GithubRepoServiceDeps) {
    this.#deps = deps
  }

  async createRepo(
    token: string,
    name: string,
    options?: { isPrivate?: boolean },
  ): Promise<GithubRepo | null> {
    const { http } = this.#deps
    const response = await http.fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        private: options?.isPrivate ?? true,
        description: BACKUP_REPO_DESCRIPTION,
        auto_init: false,
      }),
    })
    if (response.status === 403) {
      const body = (await response.text()).toLowerCase()
      if (body.includes('not accessible')) {
        return null
      }
      throw new AppError('auth', 'GitHub rejected the token (403)')
    }
    if (response.status === 401) {
      throw new AppError('auth', 'GitHub rejected the token (401)')
    }
    if (!response.ok) {
      const body = await response.text()
      throw new AppError('io', `creating the repo failed (${response.status}): ${body}`)
    }
    return toRepo(await readJson(response, repoResponseSchema, 'repo creation'))
  }

  async getRepo(token: string, ref: GithubRepoRef): Promise<GithubRepo | null> {
    const { http } = this.#deps
    const response = await http.fetch(`https://api.github.com/repos/${ref.owner}/${ref.name}`, {
      headers: apiHeaders(token),
    })
    if (response.status === 404) {
      return null
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError('auth', `GitHub rejected the token (${response.status})`)
    }
    if (!response.ok) {
      throw new AppError('io', `looking up the repo failed (${response.status})`)
    }
    return toRepo(await readJson(response, repoResponseSchema, 'repo lookup'))
  }
}

export function createGithubRepoService(deps: GithubRepoServiceDeps): GithubRepoService {
  return new GithubRepoServiceImpl(deps)
}
