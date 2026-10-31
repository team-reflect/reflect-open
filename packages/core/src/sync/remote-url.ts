import { safeParseUrl } from '@reflect/utils'
import type { GithubRepoRef } from './types.ts'

/**
 * What a graph's `origin` points at, which decides where its sign-in comes
 * from: the GitHub account for `github`, a stored host sign-in for `https`
 * (its `origin` is scheme, host and port, as `URL.origin` normalizes them),
 * and nothing for `ssh` and `path` (the SSH agent or the filesystem answer).
 */
export type GitRemote =
  | { kind: 'github'; repo: GithubRepoRef }
  | { kind: 'https'; origin: string }
  | { kind: 'ssh'; host: string }
  | { kind: 'path' }

const GITHUB_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/
/** `host:path`, as `git clone` reads it; a Windows drive (`C:/…`) is a path. */
const SCP_LIKE = /^(?![a-z]:[\\/])(?:[^@/]+@)?([^:/]+):.+$/i
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const URL_USER_INFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i

/**
 * Classify a remote URL. `http://github.com/…` is not `github`: the GitHub
 * sign-in only travels over `https`. `file://`, `git://` and other schemes
 * carry no sign-in, so they count as `path`.
 */
export function classifyRemote(url: string): GitRemote {
  if (/^https?:\/\//i.test(url)) {
    const parsed = safeParseUrl(url)
    if (parsed === null) {
      return { kind: 'path' }
    }
    // `URL` lower-cases the host and drops user info and a default port, so
    // every spelling of a github.com remote lands here.
    if (parsed.protocol === 'https:' && parsed.hostname === 'github.com') {
      const match = GITHUB_PATH.exec(parsed.pathname)
      if (match !== null) {
        return { kind: 'github', repo: { owner: match[1]!, name: match[2]! } }
      }
    }
    return { kind: 'https', origin: parsed.origin }
  }
  if (/^ssh:\/\//i.test(url)) {
    const parsed = safeParseUrl(url)
    return parsed === null ? { kind: 'path' } : { kind: 'ssh', host: parsed.hostname }
  }
  if (ANY_SCHEME.test(url)) {
    return { kind: 'path' }
  }
  const scp = SCP_LIKE.exec(url)
  if (scp !== null) {
    return { kind: 'ssh', host: scp[1]! }
  }
  return { kind: 'path' }
}

/**
 * The canonical HTTPS remote URL for a GitHub repo (token never embedded).
 */
export function githubRemoteUrl(ref: GithubRepoRef): string {
  return `https://github.com/${ref.owner}/${ref.name}.git`
}

/**
 * The remote URL as a surface may show it: any user info a URL-form remote
 * embeds (`https://alex:token@host/...`) is dropped. Other forms carry none.
 */
export function redactRemoteUrl(url: string): string {
  const parsed = safeParseUrl(url)
  if (parsed === null) {
    // A URL the parser rejects can still carry user info; strip it by shape.
    return url.replace(URL_USER_INFO, '$1')
  }
  parsed.username = ''
  parsed.password = ''
  return parsed.href
}

/**
 * The GitHub ref of a remote, for the surfaces that only exist for GitHub.
 */
export function githubRepoOf(remote: GitRemote): GithubRepoRef | null {
  return remote.kind === 'github' ? remote.repo : null
}
