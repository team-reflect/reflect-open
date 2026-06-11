import { z } from 'zod'
import { deleteSecret, getSecret, setSecret } from '../ai/secrets'

/**
 * GitHub specifics for backup/sync (Plan 12): device-flow auth, token
 * refresh, and the small REST surface (create/inspect the backup repo).
 *
 * Everything GitHub lives in this module by design — the Rust git layer and
 * the sync engine are remote-agnostic, so supporting another host later is a
 * UX decision, not an engineering project. All HTTP goes through an injected
 * `fetchFn` (the desktop passes the CORS-free Tauri fetch; tests pass fakes).
 * Tokens live in the OS keychain only.
 */

/**
 * The GitHub App client id used by the device flow. Public by design — the
 * device flow needs no client secret, even for refresh, so there is no
 * Reflect-hosted anything. Empty until the app is registered; the UI falls
 * back to fine-grained-PAT entry while it is.
 */
export const GITHUB_APP_CLIENT_ID = ''

/** Whether the guided device flow is available (a GitHub App is registered). */
export function isDeviceFlowConfigured(): boolean {
  return GITHUB_APP_CLIENT_ID.length > 0
}

/** The keychain entry holding the GitHub credential (one per machine). */
export const GITHUB_AUTH_SECRET = 'github-auth'

type FetchFn = typeof fetch

/**
 * The stored credential. `pat` covers fine-grained PATs and non-expiring App
 * tokens; `app` carries the 8-hour token + 6-month refresh token pair.
 */
export const githubAuthSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pat'), token: z.string() }),
  z.object({
    kind: z.literal('app'),
    accessToken: z.string(),
    refreshToken: z.string(),
    /** Epoch ms when `accessToken` expires. */
    expiresAt: z.number(),
  }),
])
export type GithubAuth = z.infer<typeof githubAuthSchema>

export async function saveGithubAuth(auth: GithubAuth): Promise<void> {
  await setSecret(GITHUB_AUTH_SECRET, JSON.stringify(auth))
}

/** The stored credential, or `null` when absent or unreadable (re-connect). */
export async function loadGithubAuth(): Promise<GithubAuth | null> {
  const raw = await getSecret(GITHUB_AUTH_SECRET)
  if (raw === null) {
    return null
  }
  try {
    return githubAuthSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function clearGithubAuth(): Promise<void> {
  await deleteSecret(GITHUB_AUTH_SECRET)
}

// ---- device flow -----------------------------------------------------------

export interface DeviceFlowStart {
  deviceCode: string
  /** The code the user types at {@link DeviceFlowStart.verificationUri}. */
  userCode: string
  verificationUri: string
  /** Minimum seconds between polls (GitHub enforces it). */
  intervalSeconds: number
  expiresInSeconds: number
}

const deviceStartResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  expires_in: z.number(),
  interval: z.number(),
})

const tokenResponseSchema = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  error: z.string().optional(),
  interval: z.number().optional(),
})

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' }

/** Begin the device flow: returns the code to show + where the user enters it. */
export async function deviceFlowStart(fetchFn: FetchFn = fetch): Promise<DeviceFlowStart> {
  if (!isDeviceFlowConfigured()) {
    throw new Error('GitHub device flow is not configured (no app client id)')
  }
  const response = await fetchFn('https://github.com/login/device/code', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ client_id: GITHUB_APP_CLIENT_ID }),
  })
  if (!response.ok) {
    throw new Error(`GitHub device flow start failed (${response.status})`)
  }
  const parsed = deviceStartResponseSchema.parse(await response.json())
  return {
    deviceCode: parsed.device_code,
    userCode: parsed.user_code,
    verificationUri: parsed.verification_uri,
    intervalSeconds: parsed.interval,
    expiresInSeconds: parsed.expires_in,
  }
}

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'slowDown'; intervalSeconds: number }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'authorized'; auth: GithubAuth }

/** One poll of the device flow; the caller loops on `pending`/`slowDown`. */
export async function deviceFlowPoll(
  deviceCode: string,
  fetchFn: FetchFn = fetch,
  now: () => number = Date.now,
): Promise<DevicePollResult> {
  const response = await fetchFn('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      client_id: GITHUB_APP_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  })
  const parsed = tokenResponseSchema.parse(await response.json())
  switch (parsed.error) {
    case 'authorization_pending':
      return { status: 'pending' }
    case 'slow_down':
      return { status: 'slowDown', intervalSeconds: parsed.interval ?? 10 }
    case 'expired_token':
      return { status: 'expired' }
    case 'access_denied':
      return { status: 'denied' }
    case undefined:
      break
    default:
      throw new Error(`GitHub device flow failed: ${parsed.error}`)
  }
  if (parsed.access_token === undefined) {
    throw new Error('GitHub device flow returned neither a token nor an error')
  }
  return { status: 'authorized', auth: toAuth(parsed.access_token, parsed, now()) }
}

function toAuth(
  accessToken: string,
  parsed: { refresh_token?: string; expires_in?: number },
  nowMs: number,
): GithubAuth {
  // Apps with expiring user tokens return a refresh pair; apps with expiry
  // disabled return a plain long-lived token (same handling as a PAT).
  if (parsed.refresh_token !== undefined && parsed.expires_in !== undefined) {
    return {
      kind: 'app',
      accessToken,
      refreshToken: parsed.refresh_token,
      expiresAt: nowMs + parsed.expires_in * 1000,
    }
  }
  return { kind: 'pat', token: accessToken }
}

/**
 * Refresh an expiring app token. `null` means the refresh token itself is
 * dead (lapsed/revoked) and the user must reconnect — that is the **only**
 * `null` case. Transient failures (5xx, throttling, other OAuth errors)
 * throw instead, so a flaky network can never masquerade as a disconnected
 * account and force a needless re-auth.
 */
export async function refreshGithubAuth(
  auth: Extract<GithubAuth, { kind: 'app' }>,
  fetchFn: FetchFn = fetch,
  now: () => number = Date.now,
): Promise<GithubAuth | null> {
  const response = await fetchFn('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      client_id: GITHUB_APP_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: auth.refreshToken,
    }),
  })
  if (!response.ok) {
    throw {
      kind: 'network' as const,
      message: `GitHub token refresh failed (${response.status}); will retry`,
    }
  }
  const parsed = tokenResponseSchema.parse(await response.json())
  if (parsed.access_token !== undefined) {
    return toAuth(parsed.access_token, parsed, now())
  }
  if (parsed.error === 'bad_refresh_token') {
    return null
  }
  throw {
    kind: 'auth' as const,
    message: `GitHub token refresh failed${parsed.error === undefined ? '' : ` (${parsed.error})`}`,
  }
}

/** Proactive-refresh margin: refresh when within 5 minutes of expiry. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

/**
 * The token for git/API calls, silently refreshing app tokens near expiry.
 * `null` means not connected — or the refresh token lapsed and the user must
 * reconnect (the UI maps a missing token to `Backup failed — reconnect`).
 */
export async function getGithubToken(
  fetchFn: FetchFn = fetch,
  now: () => number = Date.now,
): Promise<string | null> {
  const auth = await loadGithubAuth()
  if (auth === null) {
    return null
  }
  if (auth.kind === 'pat') {
    return auth.token
  }
  if (now() < auth.expiresAt - REFRESH_MARGIN_MS) {
    return auth.accessToken
  }
  const refreshed = await refreshGithubAuth(auth, fetchFn, now)
  if (refreshed === null) {
    return null
  }
  await saveGithubAuth(refreshed)
  return refreshed.kind === 'pat' ? refreshed.token : refreshed.accessToken
}

// ---- repositories ----------------------------------------------------------

export interface GithubRepoRef {
  owner: string
  name: string
}

/** Parse `https://github.com/owner/repo(.git)` → ref, or `null` for any other remote. */
export function parseGithubRemote(url: string): GithubRepoRef | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
  if (match === null) {
    return null
  }
  return { owner: match[1], name: match[2] }
}

/** The canonical HTTPS remote URL for a repo (token never embedded). */
export function githubRemoteUrl(ref: GithubRepoRef): string {
  return `https://github.com/${ref.owner}/${ref.name}.git`
}

export interface GithubRepo {
  fullName: string
  /** Backups must default private; a public repo needs explicit confirmation. */
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

function apiHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

function toRepo(parsed: z.infer<typeof repoResponseSchema>): GithubRepo {
  return {
    fullName: parsed.full_name,
    isPrivate: parsed.private,
    defaultBranch: parsed.default_branch,
    htmlUrl: parsed.html_url,
  }
}

/** Create a repo for the signed-in user (private by default — the backup norm). */
export async function createGithubRepo(
  token: string,
  name: string,
  options: { isPrivate?: boolean; fetchFn?: FetchFn } = {},
): Promise<GithubRepo> {
  const fetchFn = options.fetchFn ?? fetch
  const response = await fetchFn('https://api.github.com/user/repos', {
    method: 'POST',
    headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      private: options.isPrivate ?? true,
      description: 'Reflect notes backup',
      auto_init: false,
    }),
  })
  if (response.status === 401 || response.status === 403) {
    throw { kind: 'auth' as const, message: `GitHub rejected the token (${response.status})` }
  }
  if (!response.ok) {
    const body = await response.text()
    throw { kind: 'io' as const, message: `creating the repo failed (${response.status}): ${body}` }
  }
  return toRepo(repoResponseSchema.parse(await response.json()))
}

/** Look up a repo (visibility check before connecting); `null` when missing. */
export async function getGithubRepo(
  token: string,
  ref: GithubRepoRef,
  fetchFn: FetchFn = fetch,
): Promise<GithubRepo | null> {
  const response = await fetchFn(`https://api.github.com/repos/${ref.owner}/${ref.name}`, {
    headers: apiHeaders(token),
  })
  if (response.status === 404) {
    return null
  }
  if (response.status === 401 || response.status === 403) {
    throw { kind: 'auth' as const, message: `GitHub rejected the token (${response.status})` }
  }
  if (!response.ok) {
    throw { kind: 'io' as const, message: `looking up the repo failed (${response.status})` }
  }
  return toRepo(repoResponseSchema.parse(await response.json()))
}
