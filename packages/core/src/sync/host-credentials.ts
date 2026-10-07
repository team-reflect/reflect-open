import { z } from 'zod'
import { deleteSecret, getSecret, setSecret } from '../secrets/keychain.ts'
import type { GitCredential } from './commands.ts'

/**
 * Sign-ins for git hosts other than github.com, one keychain entry per
 * host (`git-host:<host>`): a username and a token presented as HTTPS
 * basic auth. GitHub keeps its own managed credential (`github-auth`);
 * SSH remotes need none (the agent answers).
 */
const hostCredentialSchema = z.object({ username: z.string(), secret: z.string() })

/** The host of an HTTPS remote URL (lowercase, with any port), else `null`. */
export function remoteHost(remoteUrl: string): string | null {
  const match = /^https?:\/\/([^/@]+@)?([^/]+)\//i.exec(
    remoteUrl.endsWith('/') ? remoteUrl : `${remoteUrl}/`,
  )
  return match === null ? null : match[2]!.toLowerCase()
}

function secretName(host: string): string {
  return `git-host:${host.toLowerCase()}`
}

export async function saveHostCredential(host: string, credential: GitCredential): Promise<void> {
  await setSecret(secretName(host), JSON.stringify(credential))
}

/** The stored sign-in for `host`, or `null` when absent or unreadable. */
export async function loadHostCredential(host: string): Promise<GitCredential | null> {
  const raw = await getSecret(secretName(host))
  if (raw === null) {
    return null
  }
  try {
    return hostCredentialSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function clearHostCredential(host: string): Promise<void> {
  await deleteSecret(secretName(host))
}
