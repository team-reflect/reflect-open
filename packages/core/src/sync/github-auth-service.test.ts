import { describe, expect, it, vi } from 'vitest'
import {
  createTestClockService,
  createTestHttpService,
  createTestSecretStoreService,
} from '../testing/index.ts'
import { createGithubAuthService, githubAppInstallUrl } from './github-auth-service.ts'

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const TOKEN_URL = 'https://github.com/login/oauth/access_token'
const USER_URL = 'https://api.github.com/user'

/**
 * A `GithubAuthService` over an in-memory keychain, an HTTP fake and a test clock.
 */
function setup(options: { secrets?: Record<string, string>; now?: number } = {}) {
  const secretStore = createTestSecretStoreService(options.secrets)
  const http = createTestHttpService()
  const clock = createTestClockService({ now: options.now ?? 0 })
  const auth = createGithubAuthService({ secretStore, http, clock })
  return { secretStore, http, clock, auth }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('GithubAuthService.deviceFlowPoll', () => {
  it('maps the GitHub pending/slow_down/denied/expired responses', async () => {
    const cases: Array<[unknown, string]> = [
      [{ error: 'authorization_pending' }, 'pending'],
      [{ error: 'slow_down', interval: 12 }, 'slowDown'],
      [{ error: 'expired_token' }, 'expired'],
      [{ error: 'access_denied' }, 'denied'],
    ]
    for (const [body, status] of cases) {
      const { auth, http } = setup()
      http.on('POST', TOKEN_URL, jsonResponse(body))
      const result = await auth.deviceFlowPoll('device-code')
      expect(result.status).toBe(status)
    }
  })

  it('returns an app credential with refresh pair and absolute expiry', async () => {
    const { auth, http } = setup({ now: 1_000_000 })
    http.on(
      'POST',
      TOKEN_URL,
      jsonResponse({
        access_token: 'ghu_token',
        refresh_token: 'ghr_refresh',
        expires_in: 28800,
      }),
    )
    const result = await auth.deviceFlowPoll('device-code')
    expect(result).toEqual({
      status: 'authorized',
      auth: {
        kind: 'app',
        accessToken: 'ghu_token',
        refreshToken: 'ghr_refresh',
        expiresAt: 1_000_000 + 28800 * 1000,
      },
    })
  })

  it('treats a non-expiring token as a plain credential', async () => {
    const { auth, http } = setup()
    http.on('POST', TOKEN_URL, jsonResponse({ access_token: 'ghu_token' }))
    const result = await auth.deviceFlowPoll('device-code')
    expect(result).toEqual({
      status: 'authorized',
      auth: { kind: 'pat', token: 'ghu_token' },
    })
  })

  it('maps a non-OK status to a retryable network error', async () => {
    const { auth, http } = setup()
    http.on('POST', TOKEN_URL, new Response('Bad Gateway', { status: 502 }))
    await expect(auth.deviceFlowPoll('device-code')).rejects.toMatchObject({
      kind: 'network',
    })
  })

  it('maps a 200 with a non-JSON body (proxy error page) to a network error', async () => {
    const { auth, http } = setup()
    http.on('POST', TOKEN_URL, new Response('<html>oops</html>', { status: 200 }))
    await expect(auth.deviceFlowPoll('device-code')).rejects.toMatchObject({
      kind: 'network',
    })
  })

  it('maps an unexpected OAuth error to an auth error', async () => {
    const { auth, http } = setup()
    http.on('POST', TOKEN_URL, jsonResponse({ error: 'incorrect_device_code' }))
    await expect(auth.deviceFlowPoll('device-code')).rejects.toMatchObject({
      kind: 'auth',
    })
  })
})

describe('GithubAuthService.getToken', () => {
  it('returns null when nothing is connected', async () => {
    const { auth } = setup()
    expect(await auth.getToken()).toBeNull()
  })

  it('returns a stored PAT without any network call', async () => {
    const { auth, http } = setup({
      secrets: { 'github-auth': JSON.stringify({ kind: 'pat', token: 'ghp_abc' }) },
    })
    expect(await auth.getToken()).toBe('ghp_abc')
    expect(http.requests()).toHaveLength(0)
  })

  it('returns a fresh app token without refreshing', async () => {
    const { auth, http } = setup({
      now: 1_000,
      secrets: {
        'github-auth': JSON.stringify({
          kind: 'app',
          accessToken: 'ghu_live',
          refreshToken: 'ghr_r',
          expiresAt: 10_000_000,
        }),
      },
    })
    expect(await auth.getToken()).toBe('ghu_live')
    expect(http.requests()).toHaveLength(0)
  })

  it('silently refreshes a near-expiry app token and persists the new pair', async () => {
    const { auth, http, secretStore } = setup({
      now: 2_000,
      secrets: {
        'github-auth': JSON.stringify({
          kind: 'app',
          accessToken: 'ghu_old',
          refreshToken: 'ghr_old',
          expiresAt: 1_000,
        }),
      },
    })
    http.on(
      'POST',
      TOKEN_URL,
      jsonResponse({
        access_token: 'ghu_new',
        refresh_token: 'ghr_new',
        expires_in: 28800,
      }),
    )
    const listener = vi.fn()
    auth.subscribe(listener)
    expect(await auth.getToken()).toBe('ghu_new')
    const saved = JSON.parse(secretStore.snapshot()['github-auth'] ?? '{}') as {
      refreshToken?: string
    }
    expect(saved.refreshToken).toBe('ghr_new')
    expect(listener).not.toHaveBeenCalled()
  })

  it('returns null when the refresh token has lapsed (re-auth required)', async () => {
    const { auth, http } = setup({
      now: 2_000,
      secrets: {
        'github-auth': JSON.stringify({
          kind: 'app',
          accessToken: 'ghu_old',
          refreshToken: 'ghr_dead',
          expiresAt: 1_000,
        }),
      },
    })
    http.on('POST', TOKEN_URL, jsonResponse({ error: 'bad_refresh_token' }))
    expect(await auth.getToken()).toBeNull()
  })

  it('refreshes with the client id that obtained the token', async () => {
    const { auth, http } = setup({
      now: 2_000,
      secrets: {
        'github-auth': JSON.stringify({
          kind: 'app',
          accessToken: 'ghu_old',
          refreshToken: 'ghr_live',
          expiresAt: 1_000,
          clientId: 'fork-app',
        }),
      },
    })
    http.on(
      'POST',
      TOKEN_URL,
      jsonResponse({ access_token: 'ghu_new', refresh_token: 'ghr_new', expires_in: 28800 }),
    )
    await auth.getToken()
    const body = JSON.parse(http.requests()[0]?.body ?? '{}') as Record<string, unknown>
    expect(body['client_id']).toBe('fork-app')
  })

  it('surfaces a transient refresh failure as retryable, not as disconnected', async () => {
    const { auth, http } = setup({
      now: 2_000,
      secrets: {
        'github-auth': JSON.stringify({
          kind: 'app',
          accessToken: 'ghu_old',
          refreshToken: 'ghr_live',
          expiresAt: 1_000,
        }),
      },
    })
    // A 5xx/throttle must throw (the engine maps it to a retryable state) —
    // never read as "account disconnected", which would force a re-auth.
    http.on('POST', TOKEN_URL, jsonResponse({ message: 'oops' }, 503))
    await expect(auth.getToken()).rejects.toMatchObject({
      kind: 'network',
    })
  })

  it('surfaces an unexpected OAuth error without dropping the stored credential', async () => {
    const { auth, http, secretStore } = setup({
      now: 2_000,
      secrets: {
        'github-auth': JSON.stringify({
          kind: 'app',
          accessToken: 'ghu_old',
          refreshToken: 'ghr_live',
          expiresAt: 1_000,
        }),
      },
    })
    http.on('POST', TOKEN_URL, jsonResponse({ error: 'incorrect_client_credentials' }))
    await expect(auth.getToken()).rejects.toMatchObject({
      kind: 'auth',
    })
    expect(secretStore.snapshot()).toHaveProperty('github-auth')
  })
})

describe('GithubAuthService.getAuthenticatedUser', () => {
  it('returns the login (instant token validation + owner for the wizard)', async () => {
    const { auth, http } = setup()
    http.on(
      'GET',
      USER_URL,
      jsonResponse({ login: 'alex', avatar_url: 'https://a.example/alex.png' }),
    )
    expect(await auth.getAuthenticatedUser('ghp_x')).toEqual({
      login: 'alex',
      avatarUrl: 'https://a.example/alex.png',
    })
  })

  it('maps a rejected token to an auth error at entry time', async () => {
    const { auth, http } = setup()
    http.on('GET', USER_URL, jsonResponse({ message: 'Bad credentials' }, 401))
    await expect(auth.getAuthenticatedUser('ghp_bad')).rejects.toMatchObject({ kind: 'auth' })
  })

  it('still treats a 403 that names bad credentials as an auth failure', async () => {
    const { auth, http } = setup()
    http.on('GET', USER_URL, jsonResponse({ message: 'Bad credentials' }, 403))
    await expect(auth.getAuthenticatedUser('ghp_bad')).rejects.toMatchObject({ kind: 'auth' })
  })

  it('classifies a rate-limit 403 as network, never auth', async () => {
    // `getSignedInUser` clears the stored credential on `auth` — a throttled
    // but valid token landing there would delete it from the keychain.
    const { auth, http } = setup()
    http.on(
      'GET',
      USER_URL,
      jsonResponse({ message: 'API rate limit exceeded for user ID 1.' }, 403),
    )
    await expect(auth.getAuthenticatedUser('ghp_x')).rejects.toMatchObject({
      kind: 'network',
    })
  })
})

describe('GithubAuthService.getSignedInUser', () => {
  it('resolves the stored credential to the signed-in identity', async () => {
    const { auth, http } = setup({
      secrets: { 'github-auth': JSON.stringify({ kind: 'pat', token: 'ghp_abc' }) },
    })
    http.on('GET', USER_URL, jsonResponse({ login: 'alex' }))

    expect(await auth.getSignedInUser()).toEqual({ login: 'alex', avatarUrl: null })
  })

  it('returns null without network when nothing is stored', async () => {
    const { auth, http } = setup()

    expect(await auth.getSignedInUser()).toBeNull()
    expect(http.requests()).toHaveLength(0)
  })

  it('clears a credential GitHub rejects before rethrowing', async () => {
    const { auth, http, secretStore } = setup({
      secrets: { 'github-auth': JSON.stringify({ kind: 'pat', token: 'ghp_dead' }) },
    })
    http.on('GET', USER_URL, jsonResponse({ message: 'Bad credentials' }, 401))
    const listener = vi.fn()
    auth.subscribe(listener)

    await expect(auth.getSignedInUser()).rejects.toMatchObject({ kind: 'auth' })
    expect(secretStore.snapshot()).not.toHaveProperty('github-auth')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps a newer credential saved while a stale lookup was in flight', async () => {
    // The auth step probes the stored credential on mount; if the user saves
    // a fresh token before that probe's rejection lands, clearing must not
    // wipe the new credential — only the token GitHub actually rejected.
    const { auth, http, secretStore } = setup({
      secrets: { 'github-auth': JSON.stringify({ kind: 'pat', token: 'ghp_old' }) },
    })
    http.on('GET', USER_URL, () => {
      void secretStore.set('github-auth', JSON.stringify({ kind: 'pat', token: 'ghp_new' }))
      return jsonResponse({ message: 'Bad credentials' }, 401)
    })

    await expect(auth.getSignedInUser()).rejects.toMatchObject({ kind: 'auth' })
    expect(JSON.parse(secretStore.snapshot()['github-auth'] ?? '{}')).toEqual({
      kind: 'pat',
      token: 'ghp_new',
    })
  })
})

describe('githubAppInstallUrl', () => {
  it('points at the registered app’s installation page', () => {
    expect(githubAppInstallUrl()).toBe(
      'https://github.com/apps/reflect-github-app/installations/new',
    )
  })
})

describe('GithubAuthService.load', () => {
  it('returns null (not a crash) for unreadable stored credentials', async () => {
    const { auth } = setup({ secrets: { 'github-auth': 'not json' } })
    expect(await auth.load()).toBeNull()
    expect(auth.getState().connected).toBe(false)
  })

  it('publishes whether a credential is stored, unknown until the first read', async () => {
    const { auth } = setup({
      secrets: { 'github-auth': JSON.stringify({ kind: 'pat', token: 'ghp_abc' }) },
    })
    expect(auth.getState().connected).toBeNull()

    await auth.load()
    expect(auth.getState().connected).toBe(true)
  })

  it('keeps a save that lands while a read is in flight', async () => {
    const { auth } = setup()
    const read = auth.load()
    await auth.save({ kind: 'pat', token: 'ghp_abc' })
    await read

    expect(auth.getState().connected).toBe(true)
  })
})

describe('GithubAuthService change notification', () => {
  it('notifies subscribers when the connection changes', async () => {
    const { auth } = setup()
    const listener = vi.fn()
    const unsubscribe = auth.subscribe(listener)

    await auth.save({ kind: 'pat', token: 'ghp_abc' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(auth.getState().connected).toBe(true)

    await auth.clear()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(auth.getState().connected).toBe(false)

    unsubscribe()
    await auth.save({ kind: 'pat', token: 'ghp_abc' })
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('GithubAuthService.runDeviceFlow', () => {
  const START_RESPONSE = {
    device_code: 'dev-1',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 5,
  }

  /**
   * Scripted GitHub: the flow start answers once, each poll pops the next response.
   */
  function scripted(polls: unknown[]) {
    const context = setup()
    context.http.on('POST', DEVICE_CODE_URL, jsonResponse(START_RESPONSE))
    context.http.on('POST', TOKEN_URL, () => {
      return jsonResponse(polls.shift() ?? { error: 'authorization_pending' })
    })
    /**
     * Resolves once the flow waits for its next poll.
     */
    const sleeping = async (): Promise<void> => {
      await vi.waitFor(() => {
        expect(context.clock.pendingTimers()).toBe(1)
      })
    }
    const pollCount = (): number => {
      return context.http.requests().filter((request) => request.url === TOKEN_URL).length
    }
    return { ...context, sleeping, pollCount }
  }

  it('surfaces the code, honors slow_down, and persists the credential', async () => {
    const { auth, clock, secretStore, sleeping, pollCount } = scripted([
      { error: 'authorization_pending' },
      { error: 'slow_down', interval: 12 },
      { access_token: 'ghp_done' },
    ])
    const codes: string[] = []
    const listener = vi.fn()
    auth.subscribe(listener)
    const flow = auth.runDeviceFlow({
      clientId: 'test-app',
      onCode: (code) => {
        codes.push(code.userCode)
      },
    })

    await sleeping()
    expect(codes).toEqual(['ABCD-1234'])
    await clock.advance(4_999)
    expect(clock.pendingTimers()).toBe(1)
    await clock.advance(1)
    await sleeping()
    expect(pollCount()).toBe(1)
    await clock.advance(5_000)
    await sleeping()
    expect(pollCount()).toBe(2)
    await clock.advance(11_999)
    expect(clock.pendingTimers()).toBe(1)
    await clock.advance(1)

    expect(await flow).toEqual({ kind: 'pat', token: 'ghp_done' })
    expect(pollCount()).toBe(3)
    expect(JSON.parse(secretStore.snapshot()['github-auth'] ?? '{}')).toEqual({
      kind: 'pat',
      token: 'ghp_done',
    })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('persists a non-default client id with app credentials', async () => {
    const { auth, clock, secretStore, sleeping } = scripted([
      { access_token: 'ghu_t', refresh_token: 'ghr_r', expires_in: 28800 },
    ])
    const flow = auth.runDeviceFlow({ clientId: 'test-app', onCode: () => {} })
    await sleeping()
    await clock.advance(5_000)
    await flow
    const saved = JSON.parse(secretStore.snapshot()['github-auth'] ?? '{}') as {
      clientId?: string
    }
    expect(saved.clientId).toBe('test-app')
  })

  it('throws an auth error when the user denies', async () => {
    const { auth, clock, sleeping } = scripted([{ error: 'access_denied' }])
    const flow = auth.runDeviceFlow({ clientId: 'test-app', onCode: () => {} })
    const rejection = expect(flow).rejects.toMatchObject({ kind: 'auth' })
    await sleeping()
    await clock.advance(5_000)
    await rejection
  })

  it('throws an auth error when the code expires while still pending', async () => {
    const { auth, clock, sleeping } = scripted([])
    const flow = auth.runDeviceFlow({ clientId: 'test-app', onCode: () => {} })
    const rejection = expect(flow).rejects.toMatchObject({ kind: 'auth' })
    // Two jumps blow past the 900s deadline.
    while (clock.now() < 900_000) {
      await sleeping()
      await clock.advance(600_000)
    }
    await rejection
  })

  it('resolves null when aborted (dialog closed) and stores nothing', async () => {
    const { auth, clock, secretStore, sleeping, pollCount } = scripted([
      { access_token: 'ghp_never' },
    ])
    const abort = new AbortController()
    const flow = auth.runDeviceFlow({
      clientId: 'test-app',
      onCode: () => {},
      signal: abort.signal,
    })
    await sleeping()
    abort.abort()
    await clock.advance(5_000)

    expect(await flow).toBeNull()
    expect(pollCount()).toBe(0)
    expect(secretStore.snapshot()).not.toHaveProperty('github-auth')
  })
})
