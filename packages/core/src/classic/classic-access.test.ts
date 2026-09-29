import { verifyChallenge } from 'pkce-challenge'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge.ts'
import type { FetchFn } from '../sync/github-api.ts'
import {
  CLASSIC_ACCESS_SECRET,
  classicAccessUntil,
  classicPaidThrough,
  loadClassicAccess,
  signInWithClassic,
  type ClassicAccess,
  type ClassicInvoice,
  type StartWebAuth,
} from './classic-access.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const YEAR_MS = 365 * DAY_MS
const NOW = Date.UTC(2026, 9, 1)
const AUGUST_END = '2026-09-01T00:00:00.000Z'
const JULY_END = '2026-08-01T00:00:00.000Z'

function invoice(overrides: Partial<ClassicInvoice> = {}): ClassicInvoice {
  return {
    status: 'paid',
    amount_paid: 1000,
    amount_refunded: 0,
    lines: [{ period_end: JULY_END }],
    ...overrides,
  }
}

/** Keychain fake over the bridge: one in-memory secret store. */
function fakeKeychain(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial))
  setBridge({
    invoke: async (command, args) => {
      const name = args['name'] as string
      if (command === 'secret_get') return store.get(name) ?? null
      if (command === 'secret_set') {
        store.set(name, args['value'] as string)
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

type Route = (init: RequestInit | undefined) => Response | Promise<Response>

/** A fetch fake that answers by URL path and records the paths it was asked for. */
function fakeFetch(routes: Record<string, Route>): { fetchFn: FetchFn; paths: string[] } {
  const paths: string[] = []
  const fetchFn: FetchFn = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname
    paths.push(path)
    const route = routes[path]
    if (route === undefined) throw new Error(`unexpected request ${path}`)
    return await route(init)
  }
  return { fetchFn, paths }
}

/** A sign-in sheet that approves and echoes the request's `state`. */
const approve: StartWebAuth = async ({ url }) => {
  const state = new URL(url).searchParams.get('state') ?? ''
  return `reflect://oauth/callback?code=the-code&state=${state}`
}

function tokenRoute(): Route {
  return () => jsonResponse({ access_token: 'the-token', access_token_id: 'id' })
}

function meRoute(paid: boolean): Route {
  return () => jsonResponse({ id: 'uid', email: 'a@example.com', subscription: { paid } })
}

function invoicesRoute(invoices: ClassicInvoice[]): Route {
  return () => jsonResponse({ invoices })
}

function storedAccess(overrides: Partial<ClassicAccess> = {}): ClassicAccess {
  return {
    token: 'the-token',
    email: 'a@example.com',
    expiresAt: NOW + 100 * DAY_MS,
    checkedAt: NOW - 2 * DAY_MS,
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  setBridge(null)
})

describe('classicPaidThrough', () => {
  it('takes the latest period end across qualifying invoices, not the first invoice', () => {
    const invoices = [
      invoice({ lines: [{ period_end: JULY_END }] }),
      invoice({ lines: [{ period_end: AUGUST_END }] }),
    ]
    expect(classicPaidThrough(invoices)).toBe(Date.parse(AUGUST_END))
  })

  it('skips unpaid, $0, and fully refunded invoices', () => {
    const invoices = [
      invoice({ status: 'open', lines: [{ period_end: AUGUST_END }] }),
      invoice({ amount_paid: 0, lines: [{ period_end: AUGUST_END }] }),
      invoice({ amount_refunded: 1000, lines: [{ period_end: AUGUST_END }] }),
      invoice({ lines: [{ period_end: JULY_END }] }),
    ]
    expect(classicPaidThrough(invoices)).toBe(Date.parse(JULY_END))
  })

  it('counts a partially refunded invoice', () => {
    expect(classicPaidThrough([invoice({ amount_refunded: 500 })])).toBe(Date.parse(JULY_END))
  })

  it('is null when nothing qualifies', () => {
    expect(classicPaidThrough([invoice({ amount_paid: 0 })])).toBeNull()
  })
})

describe('classicAccessUntil', () => {
  it('is a year from now while paid, ignoring invoices', () => {
    expect(classicAccessUntil(true, [], NOW)).toBe(NOW + YEAR_MS)
  })

  it('is a year after the last paid period once unpaid', () => {
    expect(classicAccessUntil(false, [invoice()], NOW)).toBe(Date.parse(JULY_END) + YEAR_MS)
  })

  it('is null for an account that never paid', () => {
    expect(classicAccessUntil(false, [], NOW)).toBeNull()
  })
})

describe('signInWithClassic', () => {
  it('opens the authorize page with PKCE and stores a year of access for a paying account', async () => {
    const keychain = fakeKeychain()
    let authorizeUrl = new URL('https://invalid')
    const startWebAuth = vi.fn<StartWebAuth>(async (options) => {
      authorizeUrl = new URL(options.url)
      return await approve(options)
    })
    let verifier = ''
    const { fetchFn, paths } = fakeFetch({
      '/api/oauth/token': (init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, string>
        verifier = body['code_verifier'] ?? ''
        expect(body['client_id']).toBe('reflect-open')
        expect(body['code']).toBe('the-code')
        return tokenRoute()(init)
      },
      '/api/users/me': meRoute(true),
    })

    const result = await signInWithClassic({ ephemeral: false, fetchFn, startWebAuth })

    expect(startWebAuth).toHaveBeenCalledWith(
      expect.objectContaining({ callbackScheme: 'reflect', ephemeral: false }),
    )
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://reflect.app/oauth')
    expect(authorizeUrl.searchParams.get('client_id')).toBe('reflect-open')
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe('reflect://oauth/callback')
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256')
    await expect(
      verifyChallenge(verifier, authorizeUrl.searchParams.get('code_challenge') ?? ''),
    ).resolves.toBe(true)
    expect(paths).toEqual(['/api/oauth/token', '/api/users/me'])

    const access = {
      token: 'the-token',
      email: 'a@example.com',
      expiresAt: NOW + YEAR_MS,
      checkedAt: NOW,
    }
    expect(result).toEqual({ kind: 'signed-in', access })
    expect(JSON.parse(keychain.get(CLASSIC_ACCESS_SECRET) ?? 'null')).toEqual(access)
  })

  it('uses the last paid period for an account that stopped paying', async () => {
    fakeKeychain()
    const { fetchFn, paths } = fakeFetch({
      '/api/oauth/token': tokenRoute(),
      '/api/users/me': meRoute(false),
      '/api/users/me/invoices': invoicesRoute([invoice()]),
    })

    const result = await signInWithClassic({ ephemeral: false, fetchFn, startWebAuth: approve })

    expect(paths).toEqual(['/api/oauth/token', '/api/users/me', '/api/users/me/invoices'])
    expect(result).toMatchObject({
      kind: 'signed-in',
      access: { expiresAt: Date.parse(JULY_END) + YEAR_MS },
    })
  })

  it('reports an account that never paid without storing anything', async () => {
    const keychain = fakeKeychain()
    const { fetchFn } = fakeFetch({
      '/api/oauth/token': tokenRoute(),
      '/api/users/me': meRoute(false),
      '/api/users/me/invoices': invoicesRoute([invoice({ amount_paid: 0 })]),
    })

    await expect(
      signInWithClassic({ ephemeral: true, fetchFn, startWebAuth: approve }),
    ).resolves.toEqual({ kind: 'not-eligible' })
    expect(keychain.size).toBe(0)
  })

  it('makes no request when the sheet is cancelled', async () => {
    fakeKeychain()
    const { fetchFn, paths } = fakeFetch({})

    await expect(
      signInWithClassic({ ephemeral: false, fetchFn, startWebAuth: async () => null }),
    ).resolves.toEqual({ kind: 'cancelled' })
    expect(paths).toEqual([])
  })

  it('rejects a callback whose state does not match', async () => {
    fakeKeychain()
    const { fetchFn, paths } = fakeFetch({})
    const forged: StartWebAuth = async () => 'reflect://oauth/callback?code=x&state=forged'

    await expect(
      signInWithClassic({ ephemeral: false, fetchFn, startWebAuth: forged }),
    ).rejects.toMatchObject({ kind: 'auth' })
    expect(paths).toEqual([])
  })

  it('rejects a code that Reflect Classic does not accept', async () => {
    fakeKeychain()
    const { fetchFn } = fakeFetch({
      '/api/oauth/token': () => jsonResponse({ error: { type: 'error' } }, 400),
    })

    await expect(
      signInWithClassic({ ephemeral: false, fetchFn, startWebAuth: approve }),
    ).rejects.toMatchObject({ kind: 'auth' })
  })
})

describe('loadClassicAccess', () => {
  function keychainWith(access: ClassicAccess): Map<string, string> {
    return fakeKeychain({ [CLASSIC_ACCESS_SECRET]: JSON.stringify(access) })
  }

  it('is null without a stored record', async () => {
    fakeKeychain()
    const { fetchFn, paths } = fakeFetch({})
    await expect(loadClassicAccess(fetchFn)).resolves.toBeNull()
    expect(paths).toEqual([])
  })

  it('ignores and logs an unreadable record', async () => {
    fakeKeychain({ [CLASSIC_ACCESS_SECRET]: '{"broken"' })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { fetchFn } = fakeFetch({})
    await expect(loadClassicAccess(fetchFn)).resolves.toBeNull()
    expect(error).toHaveBeenCalledOnce()
  })

  it('returns a record checked within the last day without a request', async () => {
    const access = storedAccess({ checkedAt: NOW - DAY_MS + 1 })
    keychainWith(access)
    const { fetchFn, paths } = fakeFetch({})
    await expect(loadClassicAccess(fetchFn)).resolves.toEqual(access)
    expect(paths).toEqual([])
  })

  it('extends a paying account to a year from now with one request', async () => {
    const keychain = keychainWith(storedAccess())
    const { fetchFn, paths } = fakeFetch({ '/api/users/me': meRoute(true) })

    const expected = storedAccess({ expiresAt: NOW + YEAR_MS, checkedAt: NOW })
    await expect(loadClassicAccess(fetchFn)).resolves.toEqual(expected)
    expect(paths).toEqual(['/api/users/me'])
    expect(JSON.parse(keychain.get(CLASSIC_ACCESS_SECRET) ?? 'null')).toEqual(expected)
  })

  it('keeps the expiry when the account now looks like it never paid', async () => {
    keychainWith(storedAccess())
    const { fetchFn } = fakeFetch({
      '/api/users/me': meRoute(false),
      '/api/users/me/invoices': invoicesRoute([]),
    })
    await expect(loadClassicAccess(fetchFn)).resolves.toEqual(storedAccess({ checkedAt: NOW }))
  })

  it('drops a rejected token but keeps the expiry', async () => {
    const keychain = keychainWith(storedAccess())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { fetchFn } = fakeFetch({ '/api/users/me': () => jsonResponse({}, 401) })

    const expected = storedAccess({ token: null })
    await expect(loadClassicAccess(fetchFn)).resolves.toEqual(expected)
    expect(JSON.parse(keychain.get(CLASSIC_ACCESS_SECRET) ?? 'null')).toEqual(expected)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('keeps the record unchanged when Reflect Classic cannot be reached', async () => {
    const access = storedAccess()
    const keychain = keychainWith(access)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { fetchFn } = fakeFetch({
      '/api/users/me': () => Promise.reject(new TypeError('offline')),
    })

    await expect(loadClassicAccess(fetchFn)).resolves.toEqual(access)
    expect(JSON.parse(keychain.get(CLASSIC_ACCESS_SECRET) ?? 'null')).toEqual(access)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('never rechecks once the token is gone', async () => {
    const access = storedAccess({ token: null })
    keychainWith(access)
    const { fetchFn, paths } = fakeFetch({})
    await expect(loadClassicAccess(fetchFn)).resolves.toEqual(access)
    expect(paths).toEqual([])
  })
})
