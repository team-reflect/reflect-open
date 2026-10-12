import {
  getGithubToken,
  githubCredential,
  githubRemoteUrl,
  gitClone,
  loadHostCredential,
  parseGithubRemote,
  remoteHost,
  type GitCredential,
} from '@reflect/core'
import { providerFetch } from '@/lib/provider-fetch.ts'

/** Where a backup lives: its clone URL and the folder name the clone gets. */
export interface BackupSource {
  url: string
  name: string
  /** github.com: the clone uses the GitHub sign-in, not a per-host one. */
  github: boolean
}

const SHORT_GITHUB = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/
/** A clone URL with a repository path after the host: `https://host/…`, `ssh://host/…`, or `git@host:…`. */
const CLONE_URL = /^(?:(?:https?|ssh):\/\/[^/\s]+\/\S+|git@[^:\s]+:\S+)$/i

/**
 * `owner/name` names a GitHub repository (the form the backup settings show);
 * anything else must be a full HTTPS or SSH clone URL. The folder name is
 * the repository's.
 */
export function parseBackupSource(input: string): BackupSource | null {
  const text = input.trim()
  const short = SHORT_GITHUB.exec(text)
  if (short !== null) {
    const ref = { owner: short[1]!, name: short[2]! }
    return { url: githubRemoteUrl(ref), name: ref.name, github: true }
  }
  if (!CLONE_URL.test(text)) {
    return null
  }
  const name = text
    .replace(/\/+$/, '')
    .split(/[/:]/)
    .at(-1)
    ?.replace(/\.git$/, '')
  if (name === undefined || name.length === 0) {
    return null
  }
  return { url: text, name, github: parseGithubRemote(text) !== null }
}

/**
 * The sign-in the clone presents: the managed GitHub credential for
 * github.com, the stored per-host sign-in for another HTTPS host, none for
 * SSH (the agent answers) or a host with nothing stored (a public repository).
 */
export async function backupCredential(source: BackupSource): Promise<GitCredential | null> {
  if (source.github) {
    const token = await getGithubToken(providerFetch)
    return token === null ? null : githubCredential(token)
  }
  const host = remoteHost(source.url)
  return host === null ? null : await loadHostCredential(host)
}

/** Clone `source` into `<parent>/<name>` and return the new graph's root. */
export async function restoreBackup(source: BackupSource, parent: string): Promise<string> {
  const root = `${parent.replace(/\/+$/, '')}/${source.name}`
  await gitClone(source.url, root, await backupCredential(source))
  return root
}
