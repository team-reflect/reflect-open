import type { GithubRepoRef } from './github-repo-service.ts'

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

const GITHUB_HTTPS = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/
const SCP_LIKE = /^(?:[^@/]+@)?([^:/]+):[^/]/

/**
 * Classify a remote URL. `http://github.com/…` is not `github`: the GitHub
 * sign-in only travels over `https`.
 */
export function classifyRemote(url: string): GitRemote {
  const github = GITHUB_HTTPS.exec(url)
  if (github !== null) {
    return { kind: 'github', repo: { owner: github[1]!, name: github[2]! } }
  }
  if (/^https?:\/\//i.test(url)) {
    const parsed = parseUrl(url)
    return parsed === null ? { kind: 'path' } : { kind: 'https', origin: parsed.origin }
  }
  if (/^ssh:\/\//i.test(url)) {
    const parsed = parseUrl(url)
    return parsed === null ? { kind: 'path' } : { kind: 'ssh', host: parsed.hostname }
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
 * The GitHub ref of a remote, for the surfaces that only exist for GitHub.
 */
export function githubRepoOf(remote: GitRemote): GithubRepoRef | null {
  return remote.kind === 'github' ? remote.repo : null
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}
