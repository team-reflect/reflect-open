import { redactRemoteUrl, type GitRemote } from '@reflect/core'

/**
 * How a surface names the connected remote: `alex/notes on GitHub`,
 * `gitlab.com/alex/notes`, or the URL for SSH and path remotes. A sign-in
 * written into the URL never shows.
 */
export function remoteLabel(remote: GitRemote, remoteUrl: string): string {
  switch (remote.kind) {
    case 'github':
      return `${remote.repo.owner}/${remote.repo.name} on GitHub`
    case 'https':
      // Host and path only: no scheme, no query or fragment, no `.git` suffix.
      return redactRemoteUrl(remoteUrl)
        .replace(/[?#].*$/, '')
        .replace(/^https?:\/\//i, '')
        .replace(/\.git\/?$/i, '')
    case 'ssh':
    case 'path':
      return redactRemoteUrl(remoteUrl)
  }
}
