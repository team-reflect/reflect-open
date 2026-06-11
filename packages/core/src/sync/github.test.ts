import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import {
  createGithubRepo,
  deviceFlowPoll,
  getGithubRepo,
  getGithubToken,
  githubRemoteUrl,
  loadGithubAuth,
  parseGithubRemote,
  runDeviceFlow,
} from './github'

afterEach(() => {
  setBridge(null)
})

/** Keychain fake over the bridge: one in-memory secret store. */
function fakeKeychain(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  setBridge({
    invoke: async (command, args) => {
      const name = args.name as string
      if (command === 'secret_get') {
        return store.get(name) ?? null
      }
      if (command === 'secret_set') {
        store.set(name, args.value as string)
        return null
      }
      if (command === 'secret_delete') {
        store.delete(name)
        return null
      }
      throw new Error(`unexpected command ${command}`)
    },
    listen: async () => () => {},
  })
  return store
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('parseGithubRemote', () => {
  it('parses the canonical https remote forms', () => {
    expect(parseGithubRemote('https://github.com/alex/notes.git')).toEqual({
      owner: 'alex',
      name: 'notes',
    })
    expect(parseGithubRemote('https://github.com/alex/notes')).toEqual({
      owner: 'alex',
      name: 'notes',
    })
  })

  it('returns null for non-GitHub remotes (generic core stays generic)', () => {
    expect(parseGithubRemote('https://gitlab.com/alex/notes.git')).toBeNull()
    expect(parseGithubRemote('git@github.com:alex/notes.git')).toBeNull()
    expect(parseGithubRemote('/tmp/local-remote.git')).toBeNull()
  })

  it('round-trips through githubRemoteUrl', () => {
    const url = githubRemoteUrl({ owner: 'alex', name: 'notes' })
    expect(url).toBe('https://github.com/alex/notes.git')
    expect(parseGithubRemote(url)).toEqual({ owner: 'alex', name: 'notes' })
  })
})

describe('deviceFlowPoll', () => {
  it('maps the GitHub pending/slow_down/denied/expired responses', async () => {
    const cases: Array<[unknown, string]> = [
      [{ error: 'authorization_pending' }, 'pending'],
      [{ error: 'slow_down', interval: 12 }, 'slowDown'],
      [{ error: 'expired_token' }, 'expired'],
      [{ error: 'access_denied' }, 'denied'],
    ]
    for (const [body, status] of cases) {
      const fetchFn = vi.fn(async () => jsonResponse(body))
      const result = await deviceFlowPoll('device-code', fetchFn)
      expect(result.status).toBe(status)
    }
  })

  it('returns an app credential with refresh pair and absolute expiry', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        access_token: 'ghu_token',
        refresh_token: 'ghr_refresh',
        expires_in: 28800,
      }),
    )
    const result = await deviceFlowPoll('device-code', fetchFn, () => 1_000_000)
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
    const fetchFn = vi.fn(async () => jsonResponse({ access_token: 'ghu_token' }))
    const result = await deviceFlowPoll('device-code', fetchFn)
    expect(result).toEqual({
      status: 'authorized',
      auth: { kind: 'pat', token: 'ghu_token' },
    })
  })

  it('maps a non-OK status to a retryable network error', async () => {
    const fetchFn = vi.fn(async () => new Response('Bad Gateway', { status: 502 }))
    await expect(deviceFlowPoll('device-code', fetchFn)).rejects.toMatchObject({
      kind: 'network',
    })
  })

  it('maps a 200 with a non-JSON body (proxy error page) to a network error', async () => {
    const fetchFn = vi.fn(async () => new Response('<html>oops</html>', { status: 200 }))
    await expect(deviceFlowPoll('device-code', fetchFn)).rejects.toMatchObject({
      kind: 'network',
    })
  })

  it('maps an unexpected OAuth error to an auth error', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'incorrect_device_code' }))
    await expect(deviceFlowPoll('device-code', fetchFn)).rejects.toMatchObject({
      kind: 'auth',
    })
  })
})

describe('createGithubRepo', () => {
  const REPO_RESPONSE = {
    full_name: 'alex/notes-backup',
    private: true,
    default_branch: 'main',
    html_url: 'https://github.com/alex/notes-backup',
  }

  it('creates a private repo and normalizes the response', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return jsonResponse(REPO_RESPONSE, 201)
    })
    const repo = await createGithubRepo('tok', 'notes-backup', { fetchFn })
    expect(bodies[0]).toMatchObject({ name: 'notes-backup', private: true })
    expect(repo).toEqual({
      fullName: 'alex/notes-backup',
      isPrivate: true,
      defaultBranch: 'main',
      htmlUrl: 'https://github.com/alex/notes-backup',
    })
  })

  it('maps a rejected token to an auth error', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ message: 'Bad credentials' }, 401))
    await expect(createGithubRepo('tok', 'notes-backup', { fetchFn })).rejects.toMatchObject({
      kind: 'auth',
    })
  })
})

describe('getGithubRepo', () => {
  const REF = { owner: 'alex', name: 'notes-backup' }

  it('returns null for a missing repo (the connect dialog explains, not throws)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ message: 'Not Found' }, 404))
    expect(await getGithubRepo('tok', REF, fetchFn)).toBeNull()
  })

  it('maps a rejected token to an auth error', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ message: 'Bad credentials' }, 403))
    await expect(getGithubRepo('tok', REF, fetchFn)).rejects.toMatchObject({ kind: 'auth' })
  })
})

describe('getGithubToken', () => {
  it('returns null when nothing is connected', async () => {
    fakeKeychain()
    expect(await getGithubToken()).toBeNull()
  })

  it('returns a stored PAT without any network call', async () => {
    fakeKeychain({ 'github-auth': JSON.stringify({ kind: 'pat', token: 'ghp_abc' }) })
    const fetchFn = vi.fn()
    expect(await getGithubToken(fetchFn)).toBe('ghp_abc')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('returns a fresh app token without refreshing', async () => {
    fakeKeychain({
      'github-auth': JSON.stringify({
        kind: 'app',
        accessToken: 'ghu_live',
        refreshToken: 'ghr_r',
        expiresAt: 10_000_000,
      }),
    })
    const fetchFn = vi.fn()
    expect(await getGithubToken(fetchFn, () => 1_000)).toBe('ghu_live')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('silently refreshes a near-expiry app token and persists the new pair', async () => {
    const store = fakeKeychain({
      'github-auth': JSON.stringify({
        kind: 'app',
        accessToken: 'ghu_old',
        refreshToken: 'ghr_old',
        expiresAt: 1_000,
      }),
    })
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        access_token: 'ghu_new',
        refresh_token: 'ghr_new',
        expires_in: 28800,
      }),
    )
    expect(await getGithubToken(fetchFn, () => 2_000)).toBe('ghu_new')
    const saved = JSON.parse(store.get('github-auth') ?? '{}') as { refreshToken?: string }
    expect(saved.refreshToken).toBe('ghr_new')
  })

  it('returns null when the refresh token has lapsed (re-auth required)', async () => {
    fakeKeychain({
      'github-auth': JSON.stringify({
        kind: 'app',
        accessToken: 'ghu_old',
        refreshToken: 'ghr_dead',
        expiresAt: 1_000,
      }),
    })
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'bad_refresh_token' }))
    expect(await getGithubToken(fetchFn, () => 2_000)).toBeNull()
  })

  it('refreshes with the client id that obtained the token', async () => {
    fakeKeychain({
      'github-auth': JSON.stringify({
        kind: 'app',
        accessToken: 'ghu_old',
        refreshToken: 'ghr_live',
        expiresAt: 1_000,
        clientId: 'fork-app',
      }),
    })
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return jsonResponse({ access_token: 'ghu_new', refresh_token: 'ghr_new', expires_in: 28800 })
    })
    await getGithubToken(fetchFn, () => 2_000)
    expect(bodies[0].client_id).toBe('fork-app')
  })

  it('surfaces a transient refresh failure as retryable, not as disconnected', async () => {
    fakeKeychain({
      'github-auth': JSON.stringify({
        kind: 'app',
        accessToken: 'ghu_old',
        refreshToken: 'ghr_live',
        expiresAt: 1_000,
      }),
    })
    // A 5xx/throttle must throw (the engine maps it to a retryable state) —
    // never read as "account disconnected", which would force a re-auth.
    const fetchFn = vi.fn(async () => jsonResponse({ message: 'oops' }, 503))
    await expect(getGithubToken(fetchFn, () => 2_000)).rejects.toMatchObject({
      kind: 'network',
    })
  })

  it('surfaces an unexpected OAuth error without dropping the stored credential', async () => {
    const store = fakeKeychain({
      'github-auth': JSON.stringify({
        kind: 'app',
        accessToken: 'ghu_old',
        refreshToken: 'ghr_live',
        expiresAt: 1_000,
      }),
    })
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'incorrect_client_credentials' }))
    await expect(getGithubToken(fetchFn, () => 2_000)).rejects.toMatchObject({
      kind: 'auth',
    })
    expect(store.has('github-auth')).toBe(true)
  })
})

describe('loadGithubAuth', () => {
  it('returns null (not a crash) for unreadable stored credentials', async () => {
    fakeKeychain({ 'github-auth': 'not json' })
    expect(await loadGithubAuth()).toBeNull()
  })
})

describe('runDeviceFlow', () => {
  const START_RESPONSE = {
    device_code: 'dev-1',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 5,
  }

  /** Scripted fetch: first call = flow start, later calls pop poll responses. */
  function scriptedFetch(polls: unknown[]) {
    let calls = 0
    return vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        return jsonResponse(START_RESPONSE)
      }
      return jsonResponse(polls.shift() ?? { error: 'authorization_pending' })
    })
  }

  it('surfaces the code, honors slow_down, and persists the credential', async () => {
    const store = fakeKeychain()
    const sleeps: number[] = []
    const codes: string[] = []
    const auth = await runDeviceFlow({
      clientId: 'test-app',
      fetchFn: scriptedFetch([
        { error: 'authorization_pending' },
        { error: 'slow_down', interval: 12 },
        { access_token: 'ghp_done' },
      ]),
      onCode: (code) => codes.push(code.userCode),
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      now: () => 0,
    })

    expect(codes).toEqual(['ABCD-1234'])
    expect(auth).toEqual({ kind: 'pat', token: 'ghp_done' })
    expect(sleeps).toEqual([5000, 5000, 12000])
    expect(JSON.parse(store.get('github-auth') ?? '{}')).toEqual({
      kind: 'pat',
      token: 'ghp_done',
    })
  })

  it('persists a non-default client id with app credentials', async () => {
    const store = fakeKeychain()
    await runDeviceFlow({
      clientId: 'test-app',
      fetchFn: scriptedFetch([
        { access_token: 'ghu_t', refresh_token: 'ghr_r', expires_in: 28800 },
      ]),
      onCode: () => {},
      sleep: async () => {},
      now: () => 0,
    })
    const saved = JSON.parse(store.get('github-auth') ?? '{}') as { clientId?: string }
    expect(saved.clientId).toBe('test-app')
  })

  it('throws an auth error when the user denies', async () => {
    fakeKeychain()
    await expect(
      runDeviceFlow({
        clientId: 'test-app',
      fetchFn: scriptedFetch([{ error: 'access_denied' }]),
        onCode: () => {},
        sleep: async () => {},
        now: () => 0,
      }),
    ).rejects.toMatchObject({ kind: 'auth' })
  })

  it('throws an auth error when the code expires while still pending', async () => {
    fakeKeychain()
    let clock = 0
    await expect(
      runDeviceFlow({
        clientId: 'test-app',
      fetchFn: scriptedFetch([]),
        onCode: () => {},
        sleep: async () => {
          clock += 600_000 // two sleeps blow past the 900s deadline
        },
        now: () => clock,
      }),
    ).rejects.toMatchObject({ kind: 'auth' })
  })

  it('resolves null when aborted (dialog closed) and stores nothing', async () => {
    const store = fakeKeychain()
    const abort = new AbortController()
    const auth = await runDeviceFlow({
      clientId: 'test-app',
      fetchFn: scriptedFetch([{ access_token: 'ghp_never' }]),
      onCode: () => {},
      signal: abort.signal,
      sleep: async () => {
        abort.abort()
      },
      now: () => 0,
    })
    expect(auth).toBeNull()
    expect(store.has('github-auth')).toBe(false)
  })
})
