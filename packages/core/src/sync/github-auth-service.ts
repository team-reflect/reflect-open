import { z } from 'zod'
import { safeParseJson } from '@reflect/utils'
import type { ClockService } from '../ports/clock-service.ts'
import type { HttpService } from '../ports/http-service.ts'
import { isAppError, AppError } from '../errors.ts'
import type { Unlisten } from '../unlisten.ts'
import type { SecretStoreService } from '../secrets/secret-store-service.ts'
import type { GitCredential } from './git-repository-service.ts'
import { apiHeaders, JSON_HEADERS, readJson } from './github-api.ts'

/**
 * The Reflect GitHub App's client id, used by the device flow. Public by
 * design — the device flow needs no client secret, even for refresh, so
 * there is no Reflect-hosted anything and nothing here is sensitive.
 * Registered 2026-06-11 (app id 4032425, owned by team-reflect).
 */
export const GITHUB_APP_CLIENT_ID = 'Iv23liURhf4d0EazsLl4'

/**
 * The app's public slug — `github.com/apps/<slug>`.
 */
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

/**
 * The keychain entry holding the GitHub credential (one per machine).
 */
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
    /**
     * Epoch ms when `accessToken` expires.
     */
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

export interface DeviceFlowStart {
  deviceCode: string
  /**
   * The code the user types at {@link DeviceFlowStart.verificationUri}.
   */
  userCode: string
  verificationUri: string
  /**
   * Minimum seconds between polls (GitHub enforces it).
   */
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

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'slowDown'; intervalSeconds: number }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'authorized'; auth: GithubAuth }

export interface RunDeviceFlowOptions {
  /**
   * Called once GitHub issues the code — show it and the verification URI.
   */
  onCode: (code: { userCode: string; verificationUri: string }) => void
  /**
   * Aborting stops polling and resolves `null` (the dialog was closed).
   */
  signal?: AbortSignal | undefined
  /**
   * Defaults to the registered {@link GITHUB_APP_CLIENT_ID}.
   */
  clientId?: string
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
 * GitHub accepts any token as the password of the `x-access-token` user.
 */
export function githubCredential(token: string): GitCredential {
  return { origin: 'https://github.com', username: 'x-access-token', secret: token }
}

/**
 * Proactive-refresh margin: refresh when within 5 minutes of expiry.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

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
 * The token a stored credential would supply right now (no refresh).
 */
function usableToken(auth: GithubAuth): string {
  return auth.kind === 'pat' ? auth.token : auth.accessToken
}

/**
 * What a {@link GithubAuthService} knows of the stored credential.
 */
export interface GithubAuthState {
  /**
   * Whether a credential is stored (keychain presence, not validity: a dead
   * token surfaces at use time with its real error). `null` until the first
   * keychain read.
   */
  readonly connected: boolean | null
}

/**
 * The one GitHub sign-in of this machine (not graph-scoped), kept in the keychain.
 */
export interface GithubAuthService {
  getState: () => GithubAuthState
  /**
   * The stored credential, or `null` when absent or unreadable (re-connect). Updates the state.
   */
  load(): Promise<GithubAuth | null>
  /**
   * Stores `auth` and notifies subscribers.
   */
  save(auth: GithubAuth): Promise<void>
  /**
   * Removes the stored credential and notifies subscribers.
   */
  clear(): Promise<void>
  /**
   * Called after the state changes.
   */
  subscribe: (listener: () => void) => Unlisten
  /**
   * The token for git/API calls, silently refreshing app tokens near expiry.
   * `null` means not connected — or the refresh token lapsed and the user must
   * reconnect.
   */
  getToken(): Promise<string | null>
  /**
   * Begin the device flow: returns the code to show + where the user enters it.
   */
  deviceFlowStart(clientId?: string): Promise<DeviceFlowStart>
  /**
   * One poll of the device flow; the caller loops on `pending`/`slowDown`.
   */
  deviceFlowPoll(deviceCode: string, clientId?: string): Promise<DevicePollResult>
  /**
   * Drive the whole device flow: start it, surface the user code, poll at
   * GitHub's pace (honoring `slow_down`) until it authorizes — the credential
   * is persisted to the keychain and returned — or fails. Denial and expiry
   * throw a AppError('auth'); an abort resolves `null`.
   */
  runDeviceFlow(options: RunDeviceFlowOptions): Promise<GithubAuth | null>
  /**
   * Who the token belongs to (`GET /user` — works with every token type,
   * including fine-grained PATs). Doubles as instant token validation.
   */
  getAuthenticatedUser(token: string): Promise<GithubUser>
  /**
   * Resolves the stored credential to who it belongs to via `GET /user`.
   * Doubles as token validation — the connect flow calls this right after a
   * credential is stored so a mistyped token fails at entry ("GitHub rejected
   * the token") instead of minutes later at the first sync.
   *
   * Returns `null` when no credential is stored. A credential GitHub rejects
   * is **cleared** before the auth error is rethrown — keeping it would make
   * every later flow skip the sign-in step and fail somewhere worse. The
   * clear is conditional on the keychain still holding the token GitHub
   * actually rejected: a slow rejection of an old credential (the auth step
   * probes on mount) must not wipe a newer one saved while it was in flight.
   */
  getSignedInUser(): Promise<GithubUser | null>
}

export interface GithubAuthServiceDeps {
  readonly secretStore: SecretStoreService
  readonly http: HttpService
  readonly clock: ClockService
}

class GithubAuthServiceImpl implements GithubAuthService {
  readonly #deps: GithubAuthServiceDeps
  readonly #listeners = new Set<() => void>()
  #state: GithubAuthState = { connected: null }
  // Bumped by every save and clear, so a read that started before one does not
  // overwrite its answer.
  #writes = 0

  constructor(deps: GithubAuthServiceDeps) {
    this.#deps = deps
  }

  readonly getState = (): GithubAuthState => this.#state

  async load(): Promise<GithubAuth | null> {
    const before = this.#writes
    const auth = await this.#readStored()
    if (this.#writes === before) {
      this.#setConnected(auth !== null)
    }
    return auth
  }

  async save(auth: GithubAuth): Promise<void> {
    this.#writes += 1
    await this.#store(auth)
    this.#setConnected(true)
  }

  async clear(): Promise<void> {
    this.#writes += 1
    await this.#deps.secretStore.delete(GITHUB_AUTH_SECRET)
    this.#setConnected(false)
  }

  readonly subscribe = (listener: () => void): Unlisten => {
    // Wrapped for identity, so one function added twice detaches independently.
    const deliver = (): void => {
      listener()
    }
    this.#listeners.add(deliver)
    return () => {
      this.#listeners.delete(deliver)
    }
  }

  async getToken(): Promise<string | null> {
    const { clock } = this.#deps
    const auth = await this.#readStored()
    if (auth === null) {
      return null
    }
    if (auth.kind === 'pat') {
      return auth.token
    }
    if (clock.now() < auth.expiresAt - REFRESH_MARGIN_MS) {
      return auth.accessToken
    }
    const refreshed = await this.#refresh(auth)
    if (refreshed === null) {
      return null
    }
    // A refresh keeps the machine connected, so subscribers are not notified.
    await this.#store(refreshed)
    return refreshed.kind === 'pat' ? refreshed.token : refreshed.accessToken
  }

  async deviceFlowStart(clientId: string = GITHUB_APP_CLIENT_ID): Promise<DeviceFlowStart> {
    const { http } = this.#deps
    if (clientId.length === 0) {
      throw new AppError('auth', 'GitHub device flow is not configured (no app client id)')
    }
    const response = await http.fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ client_id: clientId }),
    })
    if (!response.ok) {
      throw new AppError('network', `GitHub device flow start failed (${response.status})`)
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

  async deviceFlowPoll(
    deviceCode: string,
    clientId: string = GITHUB_APP_CLIENT_ID,
  ): Promise<DevicePollResult> {
    const { http, clock } = this.#deps
    const response = await http.fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })
    if (!response.ok) {
      throw new AppError('network', `GitHub device flow poll failed (${response.status})`)
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
        throw new AppError('auth', `GitHub device flow failed (${parsed.error})`)
    }
    if (parsed.access_token === undefined) {
      throw new AppError('parse', 'GitHub device flow returned neither a token nor an error')
    }
    return {
      status: 'authorized',
      auth: toAuth(parsed.access_token, parsed, clock.now(), clientId),
    }
  }

  async runDeviceFlow(options: RunDeviceFlowOptions): Promise<GithubAuth | null> {
    const { clock } = this.#deps
    const clientId = options.clientId ?? GITHUB_APP_CLIENT_ID

    const flow = await this.deviceFlowStart(clientId)
    options.onCode({ userCode: flow.userCode, verificationUri: flow.verificationUri })
    let intervalSeconds = flow.intervalSeconds
    const deadline = clock.now() + flow.expiresInSeconds * 1000

    while (clock.now() < deadline) {
      await clock.sleep(intervalSeconds * 1000)
      if (options.signal?.aborted === true) {
        return null
      }
      const result = await this.deviceFlowPoll(flow.deviceCode, clientId)
      switch (result.status) {
        case 'pending':
          continue
        case 'slowDown':
          intervalSeconds = result.intervalSeconds
          continue
        case 'authorized':
          await this.save(result.auth)
          return result.auth
        case 'denied':
          throw new AppError('auth', 'GitHub sign-in was denied.')
        case 'expired':
          throw new AppError('auth', 'The sign-in code expired — try again.')
      }
    }
    throw new AppError('auth', 'The sign-in code expired — try again.')
  }

  async getAuthenticatedUser(token: string): Promise<GithubUser> {
    const { http } = this.#deps
    const response = await http.fetch('https://api.github.com/user', {
      headers: apiHeaders(token),
    })
    if (response.status === 401) {
      throw new AppError('auth', 'GitHub rejected the token (401)')
    }
    if (response.status === 403) {
      const body = (await response.text()).toLowerCase()
      if (body.includes('bad credentials')) {
        throw new AppError('auth', 'GitHub rejected the token (403)')
      }
      throw new AppError(
        'network',
        'GitHub temporarily refused the signed-in user lookup (403, likely rate limiting)',
      )
    }
    if (!response.ok) {
      throw new AppError('network', `looking up the signed-in user failed (${response.status})`)
    }
    const parsed = await readJson(response, userResponseSchema, 'signed-in user lookup')
    return { login: parsed.login, avatarUrl: parsed.avatar_url ?? null }
  }

  async getSignedInUser(): Promise<GithubUser | null> {
    const before = this.#writes
    const token = await this.getToken()
    if (token === null) {
      return null
    }
    try {
      const user = await this.getAuthenticatedUser(token)
      // A stored credential GitHub accepts is a connected machine, even when
      // the first keychain read never answered. A save or clear that landed
      // meanwhile has the last word.
      if (this.#writes === before) {
        this.#setConnected(true)
      }
      return user
    } catch (error: unknown) {
      if (isAppError(error) && error.kind === 'auth') {
        const current = await this.#readStored()
        if (current !== null && usableToken(current) === token) {
          await this.clear()
        }
      }
      throw error
    }
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }

  #setConnected(connected: boolean): void {
    if (this.#state.connected === connected) {
      return
    }
    this.#state = { connected }
    this.#notify()
  }

  async #store(auth: GithubAuth): Promise<void> {
    await this.#deps.secretStore.set(GITHUB_AUTH_SECRET, JSON.stringify(auth))
  }

  async #readStored(): Promise<GithubAuth | null> {
    const raw = await this.#deps.secretStore.get(GITHUB_AUTH_SECRET)
    if (raw === null) {
      return null
    }
    const parsed = githubAuthSchema.safeParse(safeParseJson(raw))
    return parsed.success ? parsed.data : null
  }

  /**
   * Refresh an expiring app token. `null` means the refresh token itself is
   * dead (lapsed/revoked) and the user must reconnect — that is the **only**
   * `null` case. Transient failures throw instead.
   */
  async #refresh(auth: Extract<GithubAuth, { kind: 'app' }>): Promise<GithubAuth | null> {
    const { http, clock } = this.#deps
    const clientId = auth.clientId ?? GITHUB_APP_CLIENT_ID
    const response = await http.fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: auth.refreshToken,
      }),
    })
    if (!response.ok) {
      throw new AppError('network', `GitHub token refresh failed (${response.status}); will retry`)
    }
    const parsed = await readJson(response, tokenResponseSchema, 'token refresh')
    if (parsed.access_token !== undefined) {
      return toAuth(parsed.access_token, parsed, clock.now(), clientId)
    }
    if (parsed.error === 'bad_refresh_token') {
      return null
    }
    throw new AppError(
      'auth',
      `GitHub token refresh failed${parsed.error === undefined ? '' : ` (${parsed.error})`}`,
    )
  }
}

export function createGithubAuthService(deps: GithubAuthServiceDeps): GithubAuthService {
  return new GithubAuthServiceImpl(deps)
}
