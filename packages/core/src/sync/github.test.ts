import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import {
  deviceFlowPoll,
  getGithubToken,
  githubRemoteUrl,
  loadGithubAuth,
  parseGithubRemote,
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
