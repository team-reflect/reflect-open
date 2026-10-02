import { z } from 'zod'

import { deleteSecret, getSecret, setSecret } from '../secrets/keychain.ts'

/**
 * The sync domain's per-host keychain policy: credentials for
 * non-GitHub git hosts — Plan 16's generic remotes.
 *
 * The managed GitHub sign-in is **not** stored here — it lives in
 * `github.ts` under its own entry and is only ever sent to github.com. Two
 * separate stores, addressed differently, is what keeps one host's
 * credential from reaching another (Plan 16 §1).
 */

const gitCredentialSchema = z.object({
  username: z.string().min(1),
  secret: z.string().min(1),
})

/**
 * An HTTPS basic-auth credential for one fetch/push/clone, matching the Rust
 * `BasicCredential`. Rust only knows how to present one; *which* credential
 * belongs to a remote is decided here — see {@link githubCredential} and
 * {@link loadGitCredential}.
 */
export type GitCredential = z.infer<typeof gitCredentialSchema>

/** Whether `credential` has both a username and a secret — what the store accepts. */
export function isValidGitCredential(credential: GitCredential): boolean {
  return gitCredentialSchema.safeParse(credential).success
}

/**
 * The managed GitHub sign-in as a credential. GitHub App tokens authenticate
 * as the fixed username `x-access-token`; the caller has already established
 * that the remote is github.com.
 */
export function githubCredential(token: string): GitCredential {
  return { username: 'x-access-token', secret: token }
}

/**
 * The credential identity of a remote URL — its origin, as the URL parser
 * normalises it (lowercased, default port dropped) — or `null` for a remote
 * that takes no credential: a path or SSH remote, or a URL that does not
 * parse.
 *
 * The scheme is part of the identity so a credential stored for an `https`
 * remote is never sent to the `http` form of the same host in cleartext; the
 * port is, so a host on :8443 is a different credential from the same name on
 * :443.
 */
export function remoteCredentialOrigin(remoteUrl: string): string | null {
  if (!/^https?:\/\//i.test(remoteUrl)) {
    return null
  }
  try {
    return new URL(remoteUrl).origin
  } catch {
    return null
  }
}

/** The keychain account name holding the credential for `origin`. */
export function gitCredentialSecretName(origin: string): string {
  return `git-credential:${origin}`
}

/**
 * Read the stored credential for `remoteUrl`, or `null` when none is stored.
 * An unreadable entry is also `null`, so the user can re-enter it rather than
 * being wedged — but it is logged, because otherwise nothing distinguishes it
 * from a credential that was never stored.
 */
export async function loadGitCredential(remoteUrl: string): Promise<GitCredential | null> {
  const origin = remoteCredentialOrigin(remoteUrl)
  if (origin === null) {
    return null
  }
  const stored = await getSecret(gitCredentialSecretName(origin))
  if (stored === null) {
    return null
  }
  const parsed = gitCredentialSchema.safeParse(parseJson(stored))
  if (!parsed.success) {
    console.error(`the stored credential for ${origin} is unreadable; treating it as absent`)
    return null
  }
  return parsed.data
}

/** Store the credential for `remoteUrl`'s origin, replacing any existing one. */
export async function saveGitCredential(
  remoteUrl: string,
  credential: GitCredential,
): Promise<void> {
  const origin = remoteCredentialOrigin(remoteUrl)
  if (origin === null) {
    throw new Error(`not an http(s) remote, so it takes no credential: ${remoteUrl}`)
  }
  const validated = gitCredentialSchema.parse(credential)
  await setSecret(gitCredentialSecretName(origin), JSON.stringify(validated))
}

/** Forget the credential for `remoteUrl`'s origin. Idempotent. */
export async function deleteGitCredential(remoteUrl: string): Promise<void> {
  const origin = remoteCredentialOrigin(remoteUrl)
  if (origin === null) {
    return
  }
  await deleteSecret(gitCredentialSecretName(origin))
}

/** `JSON.parse`, with `undefined` for text that is not JSON (the schema then rejects it). */
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}
