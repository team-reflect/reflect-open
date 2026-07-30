import { z } from 'zod'
import { ReflectError } from '../errors'
import { deleteSecret, getSecret, setSecret } from '../secrets/keychain'
import { apiHeaders, JSON_HEADERS, readJson, type FetchFn } from './github-api'

/**
 * The Reflect GitHub App's client id, used by the device flow. Public by
 * design — the device flow needs no client secret, even for refresh, so
 * there is no Reflect-hosted anything and nothing here is sensitive.
 * Registered 2026-06-11 (app id 4032425, owned by team-reflect).
 */
export const GITHUB_APP_CLIENT_ID = 'Iv23liURhf4d0EazsLl4'

/** The app's public slug — `github.com/apps/<slug>`. */
export const GITHUB_APP_SLUG = 'reflect-github-app'

/**
 * Where the user grants the app access to repositories. Authorization
 * (device flow) and **installation** are separate GitHub App concepts: a
 * user access token can only reach repositories the app is installed on,
 * so a device-flow sign-in that can't see the backup repo sends the user
 * here to grant it.
 */
export function githubAppInstallUrl(): string {
  return `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`
}

/** Whether the guided device flow is available (a GitHub App is registered). */
export function isDeviceFlowConfigured(): boolean {
  return GITHUB_APP_CLIENT_ID.length > 0
}

/** The keychain entry holding the GitHub credential (one per machine). */
export const GITHUB_AUTH_SECRET = 'github-auth'

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
    /**
     * The client id that obtained the token, when it wasn't the built-in
     * {@link GITHUB_APP_CLIENT_ID} (e.g. an OSS fork's own app). Refreshes
     * must use the same id the token was minted with.
     */
    clientId: z.string().optional(),
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

/** Begin the device flow: returns the code to show + where the user enters it. */
export async function deviceFlowStart(
  fetchFn: FetchFn = fetch,
  clientId: string = GITHUB_APP_CLIENT_ID,
): Promise<DeviceFlowStart> {
  if (clientId.length === 0) {
    throw new ReflectError('auth', 'GitHub device flow is not configured (no app client id)')
  }
  const response = await fetchFn('https://github.com/login/device/code', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ client_id: clientId }),
  })
  if (!response.ok) {
    throw new ReflectError('network', `GitHub device flow start failed (${response.status})`)
  }
  const parsed = await readJson(response, deviceStartResponseSchema, 'device flow start')
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
  clientId: string = GITHUB_APP_CLIENT_ID,
): Promise<DevicePollResult> {
  const response = await fetchFn('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  })
  if (!response.ok) {
    throw new ReflectError('network', `GitHub device flow poll failed (${response.status})`)
  }
  const parsed = await readJson(response, tokenResponseSchema, 'device flow poll')
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
      throw new ReflectError('auth', `GitHub device flow failed (${parsed.error})`)
  }
  if (parsed.access_token === undefined) {
    throw new ReflectError('parse', 'GitHub device flow returned neither a token nor an error')
  }
  return { status: 'authorized', auth: toAuth(parsed.access_token, parsed, now(), clientId) }
}

export interface RunDeviceFlowOptions {
  fetchFn?: FetchFn
  /** Called once GitHub issues the code — show it and the verification URI. */
  onCode: (code: { userCode: string; verificationUri: string }) => void
  /** Aborting stops polling and resolves `null` (the dialog was closed). */
  signal?: AbortSignal
  /** Injected for tests; defaults to real timers. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Defaults to the registered {@link GITHUB_APP_CLIENT_ID}. */
  clientId?: string
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Drive the whole device flow: start it, surface the user code, poll at
 * GitHub's pace (honoring `slow_down`) until it authorizes — the credential
 * is persisted to the keychain and returned — or fails. Denial and expiry
 * throw a ReflectError('auth'); an abort resolves `null`.
 */
export async function runDeviceFlow(options: RunDeviceFlowOptions): Promise<GithubAuth | null> {
  const fetchFn = options.fetchFn ?? fetch
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const clientId = options.clientId ?? GITHUB_APP_CLIENT_ID

  const flow = await deviceFlowStart(fetchFn, clientId)
  options.onCode({ userCode: flow.userCode, verificationUri: flow.verificationUri })
  let intervalSeconds = flow.intervalSeconds
  const deadline = now() + flow.expiresInSeconds * 1000

  while (now() < deadline) {
    await sleep(intervalSeconds * 1000)
    if (options.signal?.aborted === true) {
      return null
    }
    const result = await deviceFlowPoll(flow.deviceCode, fetchFn, now, clientId)
    switch (result.status) {
      case 'pending':
        continue
      case 'slowDown':
        intervalSeconds = result.intervalSeconds
        continue
      case 'authorized':
        await saveGithubAuth(result.auth)
        return result.auth
      case 'denied':
        throw new ReflectError('auth', 'GitHub sign-in was denied.')
      case 'expired':
        throw new ReflectError('auth', 'The sign-in code expired — try again.')
    }
  }
  throw new ReflectError('auth', 'The sign-in code expired — try again.')
}

function toAuth(
  accessToken: string,
  parsed: { refresh_token?: string | undefined; expires_in?: number | undefined },
  nowMs: number,
  clientId: string = GITHUB_APP_CLIENT_ID,
): GithubAuth {
  if (parsed.refresh_token !== undefined && parsed.expires_in !== undefined) {
    return {
      kind: 'app',
      accessToken,
      refreshToken: parsed.refresh_token,
      expiresAt: nowMs + parsed.expires_in * 1000,
      clientId: clientId === GITHUB_APP_CLIENT_ID ? undefined : clientId,
    }
  }
  return { kind: 'pat', token: accessToken }
}

/**
 * Refresh an expiring app token. `null` means the refresh token itself is
 * dead (lapsed/revoked) and the user must reconnect — that is the **only**
 * `null` case. Transient failures throw instead.
 */
export async function refreshGithubAuth(
  auth: Extract<GithubAuth, { kind: 'app' }>,
  fetchFn: FetchFn = fetch,
  now: () => number = Date.now,
): Promise<GithubAuth | null> {
  const clientId = auth.clientId ?? GITHUB_APP_CLIENT_ID
  const response = await fetchFn('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: auth.refreshToken,
    }),
  })
  if (!response.ok) {
    throw new ReflectError(
      'network',
      `GitHub token refresh failed (${response.status}); will retry`,
    )
  }
  const parsed = await readJson(response, tokenResponseSchema, 'token refresh')
  if (parsed.access_token !== undefined) {
    return toAuth(parsed.access_token, parsed, now(), clientId)
  }
  if (parsed.error === 'bad_refresh_token') {
    return null
  }
  throw new ReflectError(
    'auth',
    `GitHub token refresh failed${parsed.error === undefined ? '' : ` (${parsed.error})`}`,
  )
}

/** Proactive-refresh margin: refresh when within 5 minutes of expiry. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

/**
 * The token for git/API calls, silently refreshing app tokens near expiry.
 * `null` means not connected — or the refresh token lapsed and the user must
 * reconnect.
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

export interface GithubUser {
  login: string
  avatarUrl: string | null
}

const userResponseSchema = z.object({
  login: z.string(),
  avatar_url: z.string().optional(),
})

/**
 * Who the token belongs to (`GET /user` — works with every token type,
 * including fine-grained PATs). Doubles as instant token validation.
 */
export async function getAuthenticatedUser(
  token: string,
  fetchFn: FetchFn = fetch,
): Promise<GithubUser> {
  const response = await fetchFn('https://api.github.com/user', {
    headers: apiHeaders(token),
  })
  if (response.status === 401) {
    throw new ReflectError('auth', 'GitHub rejected the token (401)')
  }
  if (response.status === 403) {
    const body = (await response.text()).toLowerCase()
    if (body.includes('bad credentials')) {
      throw new ReflectError('auth', 'GitHub rejected the token (403)')
    }
    throw new ReflectError(
      'network',
      'GitHub temporarily refused the signed-in user lookup (403, likely rate limiting)',
    )
  }
  if (!response.ok) {
    throw new ReflectError('network', `looking up the signed-in user failed (${response.status})`)
  }
  const parsed = await readJson(response, userResponseSchema, 'signed-in user lookup')
  return { login: parsed.login, avatarUrl: parsed.avatar_url ?? null }
}
