import type { MaybePromise } from '@reflect/utils'
import { verifyChallenge } from 'pkce-challenge'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSystemIdService, type IdService } from '../ports/id-service.ts'
import type { AppPlatform } from '../ports/platform-facts.ts'
import { createTestClockService, type TestClockService } from '../testing/clock.ts'
import { createTestHttpService, type TestHttpService } from '../testing/http.ts'
import { createTestIdService } from '../testing/id.ts'
import { createTestLoggerService, type TestLoggerService } from '../testing/logger.ts'
import { createTestPlatformService } from '../testing/platform.ts'
import { createTestWebAuthService, type TestWebAuthService } from '../testing/plugins.ts'
import { createTestSecretStoreService, type TestSecretStoreService } from '../testing/secrets.ts'
import { createTestActivityPort, type TestActivityPort } from '../testing/shell.ts'
import {
  CLASSIC_ACCESS_SECRET,
  classicAccessUntil,
  classicPaidThrough,
  createClassicAccessService,
  type ClassicAccess,
  type ClassicAccessService,
  type ClassicInvoice,
} from './classic-access-service.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const YEAR_MS = 365 * DAY_MS
const NOW = Date.UTC(2026, 9, 1)
const AUGUST_END = '2026-09-01T00:00:00.000Z'
const JULY_END = '2026-08-01T00:00:00.000Z'
const ORIGIN = 'https://reflect.app'

function invoice(overrides: Partial<ClassicInvoice> = {}): ClassicInvoice {
  return {
    status: 'paid',
    amount_paid: 1000,
    amount_refunded: 0,
    lines: [{ period_end: JULY_END }],
    ...overrides,
  }
}

type Route = (request: Request) => MaybePromise<Response>

function tokenRoute(): Route {
  return () => Response.json({ access_token: 'the-token', access_token_id: 'id' })
}

function meRoute(paid: boolean): Route {
  return () => Response.json({ id: 'uid', email: 'a@example.com', subscription: { paid } })
}

function invoicesRoute(invoices: ClassicInvoice[]): Route {
  return () => Response.json({ invoices })
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

/**
 * The callback of a sign-in sheet that approves `url` and echoes its `state`.
 */
function approve(url: string): string {
  const state = new URL(url).searchParams.get('state') ?? ''
  return `reflect://oauth/callback?code=the-code&state=${state}`
}

let logger: TestLoggerService
let clock: TestClockService
let http: TestHttpService
let secrets: TestSecretStoreService
let webAuth: TestWebAuthService
let activity: TestActivityPort

beforeEach(() => {
  activity = createTestActivityPort()
  logger = createTestLoggerService()
  clock = createTestClockService({ now: NOW })
  http = createTestHttpService()
  secrets = createTestSecretStoreService()
  webAuth = createTestWebAuthService(null)
})

/**
 * Answers each path under the Reflect Classic origin with its route.
 */
function routes(byPath: Record<string, Route>): void {
  for (const [path, route] of Object.entries(byPath)) {
    http.on('*', `${ORIGIN}${path}`, route)
  }
}

function paths(): string[] {
  return http.requests().map((request) => new URL(request.url).pathname)
}

function service(options?: {
  id?: IdService
  approved?: boolean
  appPlatform?: AppPlatform
}): ClassicAccessService {
  const approved = options?.approved ?? true
  return createClassicAccessService({
    secretStore: secrets,
    http,
    webAuth: approved
      ? {
          start: async (start) => {
            await webAuth.start(start)
            return approve(start.url)
          },
        }
      : webAuth,
    clock,
    id: options?.id ?? createTestIdService(),
    activity,
    platform: createTestPlatformService({ appPlatform: options?.appPlatform ?? 'ios' }),
    logger,
  })
}

function stored(): unknown {
  return JSON.parse(secrets.snapshot()[CLASSIC_ACCESS_SECRET] ?? 'null')
}

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

describe('signIn', () => {
  it('opens the authorize page with PKCE and stores a year of access for a paying account', async () => {
    let verifier = ''
    routes({
      '/api/oauth/token': async (request) => {
        const body = (await request.json()) as Record<string, string>
        verifier = body['code_verifier'] ?? ''
        expect(body['client_id']).toBe('reflect-open')
        expect(body['code']).toBe('the-code')
        return await tokenRoute()(request)
      },
      '/api/users/me': meRoute(true),
    })
    let closed = 0

    const result = await service({ id: createSystemIdService() }).signIn({
      ephemeral: false,
      onSheetClosed: () => {
        closed += 1
      },
    })

    const [start] = webAuth.starts()
    expect(start).toMatchObject({ callbackScheme: 'reflect', ephemeral: false })
    const authorizeUrl = new URL(start?.url ?? 'https://invalid')
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://reflect.app/oauth')
    expect(authorizeUrl.searchParams.get('client_id')).toBe('reflect-open')
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe('reflect://oauth/callback')
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256')
    await expect(
      verifyChallenge(verifier, authorizeUrl.searchParams.get('code_challenge') ?? ''),
    ).resolves.toBe(true)
    expect(paths()).toEqual(['/api/oauth/token', '/api/users/me'])
    expect(closed).toBe(1)

    const access = {
      token: 'the-token',
      email: 'a@example.com',
      expiresAt: NOW + YEAR_MS,
      checkedAt: NOW,
    }
    expect(result).toEqual({ kind: 'signed-in', access })
    expect(stored()).toEqual(access)
  })

  it('leaves the state alone until the next read', async () => {
    routes({ '/api/oauth/token': tokenRoute(), '/api/users/me': meRoute(true) })
    const classic = service()

    await classic.signIn({ ephemeral: false })
    expect(classic.getState()).toEqual({ access: null, active: false, isLoading: true })

    await classic.read()
    expect(classic.getState()).toMatchObject({ active: true, isLoading: false })
  })

  it('uses the last paid period for an account that stopped paying', async () => {
    routes({
      '/api/oauth/token': tokenRoute(),
      '/api/users/me': meRoute(false),
      '/api/users/me/invoices': invoicesRoute([invoice()]),
    })

    const result = await service().signIn({ ephemeral: false })

    expect(paths()).toEqual(['/api/oauth/token', '/api/users/me', '/api/users/me/invoices'])
    expect(result).toMatchObject({
      kind: 'signed-in',
      access: { expiresAt: Date.parse(JULY_END) + YEAR_MS },
    })
  })

  it('takes `state` from the `IdService` and sends a matching PKCE pair', async () => {
    const id = createTestIdService()
    let verifier = ''
    routes({
      '/api/oauth/token': async (request) => {
        const body = (await request.json()) as Record<string, string>
        verifier = body['code_verifier'] ?? ''
        return await tokenRoute()(request)
      },
      '/api/users/me': meRoute(true),
    })

    await service({ id }).signIn({ ephemeral: false })

    const authorizeUrl = new URL(webAuth.starts()[0]?.url ?? 'https://invalid')
    expect(authorizeUrl.searchParams.get('state')).toBe(id.issued()[0])
    expect(verifier).toHaveLength(43)
    await expect(
      verifyChallenge(verifier, authorizeUrl.searchParams.get('code_challenge') ?? ''),
    ).resolves.toBe(true)
  })

  it('reports an account that never paid without storing anything', async () => {
    routes({
      '/api/oauth/token': tokenRoute(),
      '/api/users/me': meRoute(false),
      '/api/users/me/invoices': invoicesRoute([invoice({ amount_paid: 0 })]),
    })

    await expect(service().signIn({ ephemeral: true })).resolves.toEqual({
      kind: 'not-eligible',
      email: 'a@example.com',
    })
    expect(webAuth.starts()[0]?.ephemeral).toBe(true)
    expect(secrets.snapshot()).toEqual({})
  })

  it('makes no request when the sheet is cancelled', async () => {
    let closed = 0
    await expect(
      service({ approved: false }).signIn({
        ephemeral: false,
        onSheetClosed: () => {
          closed += 1
        },
      }),
    ).resolves.toEqual({ kind: 'cancelled' })
    expect(paths()).toEqual([])
    expect(closed).toBe(0)
  })

  it('rejects a callback whose state does not match', async () => {
    webAuth.setCallbackUrl('reflect://oauth/callback?code=x&state=forged')

    await expect(service({ approved: false }).signIn({ ephemeral: false })).rejects.toMatchObject({
      kind: 'auth',
    })
    expect(paths()).toEqual([])
  })

  it('rejects and logs a code that Reflect Classic does not accept', async () => {
    routes({
      '/api/oauth/token': () => Response.json({ error: { type: 'error' } }, { status: 400 }),
    })

    await expect(service().signIn({ ephemeral: false })).rejects.toMatchObject({ kind: 'auth' })
    expect(logger.getWarnings()).toEqual([
      { message: 'Reflect Classic answered 400 (/api/oauth/token)', cause: undefined },
    ])
  })

  it('reports and logs an error status as a network failure', async () => {
    routes({
      '/api/oauth/token': tokenRoute(),
      '/api/users/me': () => Response.json({ error: { type: 'error' } }, { status: 500 }),
    })

    await expect(service().signIn({ ephemeral: false })).rejects.toMatchObject({
      kind: 'network',
    })
    expect(logger.getWarnings()).toEqual([
      { message: 'Reflect Classic answered 500 (/api/users/me)', cause: undefined },
    ])
  })

  it('reports and logs a body that is not JSON as a parse failure', async () => {
    routes({
      '/api/oauth/token': tokenRoute(),
      '/api/users/me': () => new Response('<html>oops</html>', { status: 200 }),
    })

    await expect(service().signIn({ ephemeral: false })).rejects.toMatchObject({ kind: 'parse' })
    expect(logger.getWarnings()).toEqual([
      {
        message: 'Reflect Classic returned a body that is not JSON (/api/users/me)',
        cause: expect.any(SyntaxError) as SyntaxError,
      },
    ])
  })

  it('reports and logs a body with an unexpected shape as a parse failure', async () => {
    routes({
      '/api/oauth/token': tokenRoute(),
      '/api/users/me': () => Response.json({ email: 'a@example.com' }),
    })

    await expect(service().signIn({ ephemeral: false })).rejects.toMatchObject({ kind: 'parse' })
    const warnings = logger.getWarnings()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toBe('Reflect Classic returned an unexpected body (/api/users/me)')
    expect(warnings[0]?.cause).toBeDefined()
  })

  it('reports and logs an invoice period end that is not a date as a parse failure', async () => {
    routes({
      '/api/oauth/token': tokenRoute(),
      '/api/users/me': meRoute(false),
      '/api/users/me/invoices': invoicesRoute([invoice({ lines: [{ period_end: 'soon' }] })]),
    })

    await expect(service().signIn({ ephemeral: false })).rejects.toMatchObject({ kind: 'parse' })
    const warnings = logger.getWarnings()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toBe(
      'Reflect Classic returned an unexpected body (/api/users/me/invoices)',
    )
    expect(warnings[0]?.cause).toBeDefined()
  })

  it('reports a request that cannot be sent as a network failure', async () => {
    routes({ '/api/oauth/token': () => Promise.reject(new TypeError('offline')) })

    await expect(service().signIn({ ephemeral: false })).rejects.toMatchObject({
      kind: 'network',
    })
  })
})

describe('read', () => {
  it('returns a record older than a day without a request', async () => {
    const access = storedAccess({ checkedAt: NOW - 30 * DAY_MS })
    secrets = createTestSecretStoreService({ [CLASSIC_ACCESS_SECRET]: JSON.stringify(access) })
    const classic = service()

    await expect(classic.read()).resolves.toEqual(access)
    expect(paths()).toEqual([])
    expect(classic.getState()).toEqual({ access, active: true, isLoading: false })
  })

  it('is null without a stored record', async () => {
    const classic = service()
    expect(classic.getState().isLoading).toBe(true)

    await expect(classic.read()).resolves.toBeNull()
    expect(classic.getState()).toEqual({ access: null, active: false, isLoading: false })
  })

  it('reports an expired record as inactive by the clock', async () => {
    const access = storedAccess({ expiresAt: NOW + DAY_MS })
    secrets = createTestSecretStoreService({ [CLASSIC_ACCESS_SECRET]: JSON.stringify(access) })
    const classic = service()
    clock.setNow(NOW + 2 * DAY_MS)

    await classic.read()
    expect(classic.getState().active).toBe(false)
  })

  it('stops loading and rethrows when the keychain fails', async () => {
    secrets = createTestSecretStoreService()
    vi.spyOn(secrets, 'get').mockRejectedValue(new Error('locked'))
    const classic = service()
    const notified: boolean[] = []
    classic.subscribe(() => {
      notified.push(classic.getState().isLoading)
    })

    await expect(classic.read()).rejects.toThrow('locked')
    expect(notified).toEqual([false])
  })
})

describe('load', () => {
  function withStored(access: ClassicAccess): void {
    secrets = createTestSecretStoreService({ [CLASSIC_ACCESS_SECRET]: JSON.stringify(access) })
  }

  it('is null without a stored record', async () => {
    await expect(service().load()).resolves.toBeNull()
    expect(paths()).toEqual([])
  })

  it('ignores and logs an unreadable record', async () => {
    secrets = createTestSecretStoreService({ [CLASSIC_ACCESS_SECRET]: '{"broken"' })
    await expect(service().load()).resolves.toBeNull()
    expect(logger.getErrors()).toHaveLength(1)
  })

  it('returns a record checked within the last day without a request', async () => {
    const access = storedAccess({ checkedAt: NOW - DAY_MS + 1 })
    withStored(access)
    await expect(service().load()).resolves.toEqual(access)
    expect(paths()).toEqual([])
  })

  it('rechecks once the clock passes a day since the last check', async () => {
    const access = storedAccess({ checkedAt: NOW - DAY_MS + 1000 })
    withStored(access)
    routes({ '/api/users/me': meRoute(true) })
    const classic = service()

    await classic.load()
    expect(paths()).toEqual([])
    await clock.advance(1000)
    await classic.load()
    expect(paths()).toEqual(['/api/users/me'])
  })

  it('extends a paying account to a year from now with one request', async () => {
    withStored(storedAccess())
    routes({ '/api/users/me': meRoute(true) })
    const classic = service()

    const expected = storedAccess({ expiresAt: NOW + YEAR_MS, checkedAt: NOW })
    await expect(classic.load()).resolves.toEqual(expected)
    expect(paths()).toEqual(['/api/users/me'])
    expect(stored()).toEqual(expected)
    expect(classic.getState()).toEqual({ access: expected, active: true, isLoading: false })
  })

  it('shares one recheck between overlapping calls', async () => {
    withStored(storedAccess())
    routes({ '/api/users/me': meRoute(true) })
    const classic = service()

    const [first, second] = await Promise.all([classic.load(), classic.load()])
    expect(second).toBe(first)
    expect(paths()).toEqual(['/api/users/me'])
  })

  it('keeps the expiry when the account now looks like it never paid', async () => {
    withStored(storedAccess())
    routes({ '/api/users/me': meRoute(false), '/api/users/me/invoices': invoicesRoute([]) })
    await expect(service().load()).resolves.toEqual(storedAccess({ checkedAt: NOW }))
  })

  it('drops a rejected token but keeps the expiry', async () => {
    withStored(storedAccess())
    routes({ '/api/users/me': () => Response.json({}, { status: 401 }) })

    const expected = storedAccess({ token: null })
    await expect(service().load()).resolves.toEqual(expected)
    expect(stored()).toEqual(expected)
    expect(logger.getWarnings()).toHaveLength(1)
  })

  it('keeps the record unchanged when Reflect Classic cannot be reached', async () => {
    const access = storedAccess()
    withStored(access)
    routes({ '/api/users/me': () => Promise.reject(new TypeError('offline')) })

    await expect(service().load()).resolves.toEqual(access)
    expect(stored()).toEqual(access)
    expect(logger.getWarnings()).toHaveLength(1)
  })

  it('never rechecks once the token is gone', async () => {
    const access = storedAccess({ token: null })
    withStored(access)
    await expect(service().load()).resolves.toEqual(access)
    expect(paths()).toEqual([])
  })
})

describe('signOut', () => {
  it('deletes the record and publishes no access', async () => {
    secrets = createTestSecretStoreService({
      [CLASSIC_ACCESS_SECRET]: JSON.stringify(storedAccess()),
    })
    const classic = service()
    await classic.read()
    let notified = 0
    classic.subscribe(() => {
      notified += 1
    })

    await classic.signOut()

    expect(secrets.snapshot()).toEqual({})
    expect(classic.getState()).toEqual({ access: null, active: false, isLoading: false })
    expect(notified).toBe(1)
  })
})

describe('start', () => {
  function withStored(access: ClassicAccess): void {
    secrets = createTestSecretStoreService({ [CLASSIC_ACCESS_SECRET]: JSON.stringify(access) })
  }

  it('reads the stored access, then rechecks a token now and whenever the page turns visible', async () => {
    withStored(storedAccess())
    routes({ '/api/users/me': meRoute(true) })
    const classic = service()

    classic.start()
    await vi.waitFor(() => expect(paths()).toEqual(['/api/users/me']))
    expect(classic.getState().access?.checkedAt).toBe(NOW)

    await clock.advance(DAY_MS)
    activity.emitVisible()
    await vi.waitFor(() => expect(paths()).toEqual(['/api/users/me', '/api/users/me']))
  })

  it('reads without rechecking when no token is stored', async () => {
    withStored(storedAccess({ token: null }))
    const classic = service()

    classic.start()
    await vi.waitFor(() => expect(classic.getState().isLoading).toBe(false))
    const reads = vi.spyOn(secrets, 'get')
    activity.emitVisible()

    expect(reads).not.toHaveBeenCalled()
  })

  it('stops rechecking once the token is gone', async () => {
    withStored(storedAccess())
    routes({ '/api/users/me': meRoute(true) })
    const classic = service()
    classic.start()
    await vi.waitFor(() => expect(paths()).toHaveLength(1))

    await classic.signOut()
    const reads = vi.spyOn(secrets, 'get')
    activity.emitVisible()

    expect(reads).not.toHaveBeenCalled()
  })

  it('stops rechecking when stopped', async () => {
    withStored(storedAccess())
    routes({ '/api/users/me': meRoute(true) })
    const classic = service()
    const stop = classic.start()
    await vi.waitFor(() => expect(paths()).toHaveLength(1))

    stop()
    const reads = vi.spyOn(secrets, 'get')
    activity.emitVisible()

    expect(reads).not.toHaveBeenCalled()
  })

  it('logs a failed keychain read', async () => {
    secrets = createTestSecretStoreService()
    vi.spyOn(secrets, 'get').mockRejectedValue(new Error('locked'))
    service().start()

    await vi.waitFor(() =>
      expect(logger.getErrors()).toEqual([
        { message: 'Reading the Reflect Classic access failed', cause: new Error('locked') },
      ]),
    )
  })

  it('does nothing off iOS', () => {
    withStored(storedAccess())
    const reads = vi.spyOn(secrets, 'get')
    const classic = service({ appPlatform: 'desktop' })

    classic.start()
    activity.emitVisible()

    expect(reads).not.toHaveBeenCalled()
  })
})
