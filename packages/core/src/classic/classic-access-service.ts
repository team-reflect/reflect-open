import type { MaybePromise } from '@reflect/utils'
import pkceChallenge from 'pkce-challenge'
import { z } from 'zod'
import type { ClockService } from '../ports/clock-service.ts'
import type { HttpService } from '../ports/http-service.ts'
import type { IdService } from '../ports/id-service.ts'
import type { ActivityPort } from '../ports/activity-port.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { PlatformFacts } from '../ports/platform-facts.ts'
import { AppError, isAppError } from '../errors.ts'
import type { Unlisten } from '../unlisten.ts'
import type { WebAuthService } from '../ipc/web-auth-service.ts'
import type { SecretStoreService } from '../secrets/secret-store-service.ts'

/**
 * Reflect Open access granted by a Reflect Classic subscription: sign in with
 * a Classic account through OAuth (PKCE), read its subscription and invoices,
 * and keep the resulting expiry, plus the token to recheck it, in the keychain.
 */

const CLASSIC_ORIGIN = 'https://reflect.app'
const CLASSIC_OAUTH_CLIENT_ID = 'reflect-open'
const CALLBACK_SCHEME = 'reflect'
const REDIRECT_URI = `${CALLBACK_SCHEME}://oauth/callback`
const DAY_MS = 24 * 60 * 60 * 1000
const RECHECK_INTERVAL_MS = DAY_MS
/**
 * How long Reflect Open stays usable after the last paid Classic period.
 */
const ACCESS_AFTER_PAYMENT_MS = 365 * DAY_MS

/**
 * The keychain entry holding this device's Reflect Classic access.
 */
export const CLASSIC_ACCESS_SECRET = 'reflect-classic-access'

export const classicAccessSchema = z.object({
  /**
   * The Reflect Classic OAuth access token; null once Classic rejects it.
   */
  token: z.string().nullable(),
  email: z.string().nullable(),
  /**
   * Epoch ms.
   */
  expiresAt: z.number(),
  /**
   * Epoch ms of the last successful check with Reflect Classic.
   */
  checkedAt: z.number(),
})
export type ClassicAccess = z.infer<typeof classicAccessSchema>

export type ClassicSignInResult =
  | { kind: 'cancelled' }
  | { kind: 'not-eligible'; email: string | null }
  | { kind: 'signed-in'; access: ClassicAccess }

export interface ClassicSignInOptions {
  /**
   * Asks for a private web session that shares no cookies with the system browser.
   */
  ephemeral: boolean
  /**
   * Called once the sign-in sheet closes with a callback, before the account is read.
   */
  onSheetClosed?: () => void
}

/**
 * The stored access as last published by `read`, `load`, or `signOut`.
 */
export interface ClassicAccessState {
  readonly access: ClassicAccess | null
  /**
   * Whether `access` unlocked Reflect Open when the state last changed.
   */
  readonly active: boolean
  /**
   * True until the first keychain read settles.
   */
  readonly isLoading: boolean
}

export interface ClassicAccessServiceDeps {
  readonly secretStore: SecretStoreService
  readonly http: HttpService
  readonly webAuth: WebAuthService
  readonly clock: ClockService
  readonly id: IdService
  readonly activity: ActivityPort
  readonly platform: PlatformFacts
  readonly logger: LoggerService
}

/**
 * Reflect Open access through a paid Reflect Classic account.
 */
export interface ClassicAccessService {
  getState: () => ClassicAccessState
  subscribe: (listener: () => void) => Unlisten
  /**
   * This device's stored access, without contacting Reflect Classic.
   */
  read(): MaybePromise<ClassicAccess | null>
  /**
   * This device's stored access, rechecked with Reflect Classic when the last
   * successful check is more than a day old. A failed recheck keeps the stored
   * answer, so being offline never locks the app early.
   */
  load(): MaybePromise<ClassicAccess | null>
  /**
   * Signs in to Reflect Classic and stores the access it grants. The state
   * changes on the next `read` or `load`, so a caller can show the result
   * before the paywall lifts.
   */
  signIn(options: ClassicSignInOptions): Promise<ClassicSignInResult>
  /**
   * Forgets this device's access.
   */
  signOut(): MaybePromise<void>
  /**
   * On iOS, reads the stored access now and, while it holds a token, rechecks
   * it now and whenever the page turns visible. Elsewhere it does nothing.
   */
  start(): Unlisten
}

const meSchema = z.object({
  email: z.string().nullable(),
  subscription: z.object({ paid: z.boolean() }),
})

const invoiceSchema = z.object({
  status: z.string().nullable(),
  amount_paid: z.number(),
  amount_refunded: z.number(),
  lines: z.array(z.object({ period_end: z.iso.datetime() })),
})
export type ClassicInvoice = z.infer<typeof invoiceSchema>

const invoicesSchema = z.object({ invoices: z.array(invoiceSchema) })

const tokenSchema = z.object({ access_token: z.string() })

export function isClassicAccessActive(access: ClassicAccess, now: number): boolean {
  return access.expiresAt > now
}

/**
 * End (epoch ms) of the latest service period covered by a paid invoice that
 * was not fully refunded, or `null` when there is none. Takes the maximum
 * rather than the first match because creation order does not follow service
 * periods (for example, a later proration invoice).
 */
export function classicPaidThrough(invoices: readonly ClassicInvoice[]): number | null {
  const ends = invoices
    .filter((invoice) => invoice.status === 'paid' && invoice.amount_paid > invoice.amount_refunded)
    .flatMap((invoice) => invoice.lines.map((line) => Date.parse(line.period_end)))
  return ends.length > 0 ? Math.max(...ends) : null
}

/**
 * Until when (epoch ms) Reflect Classic unlocks Reflect Open: a year from now
 * while paid, otherwise a year after the last paid period. `null` when the
 * account never paid.
 */
export function classicAccessUntil(
  paid: boolean,
  invoices: readonly ClassicInvoice[],
  now: number,
): number | null {
  if (paid) return now + ACCESS_AFTER_PAYMENT_MS
  const paidThrough = classicPaidThrough(invoices)
  return paidThrough === null ? null : paidThrough + ACCESS_AFTER_PAYMENT_MS
}

class ClassicAccessServiceImpl implements ClassicAccessService {
  readonly #deps: ClassicAccessServiceDeps
  readonly #listeners = new Set<() => void>()
  #state: ClassicAccessState = { access: null, active: false, isLoading: true }
  #pendingLoad: Promise<ClassicAccess | null> | null = null

  constructor(deps: ClassicAccessServiceDeps) {
    this.#deps = deps
  }

  readonly getState = (): ClassicAccessState => this.#state

  readonly subscribe = (listener: () => void): Unlisten => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  read(): Promise<ClassicAccess | null> {
    return this.#settle(this.#readStored())
  }

  load(): Promise<ClassicAccess | null> {
    if (this.#pendingLoad === null) {
      const next = this.#settle(this.#recheck())
      this.#pendingLoad = next
      const clear = (): void => {
        if (this.#pendingLoad === next) this.#pendingLoad = null
      }
      void next.then(clear, clear)
    }
    return this.#pendingLoad
  }

  async signIn(options: ClassicSignInOptions): Promise<ClassicSignInResult> {
    const { webAuth, clock, id } = this.#deps
    const { code_verifier: verifier, code_challenge: challenge } = await pkceChallenge()
    const oauthState = id.uuid()
    const params = new URLSearchParams({
      client_id: CLASSIC_OAUTH_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state: oauthState,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })
    const callback = await webAuth.start({
      url: `${CLASSIC_ORIGIN}/oauth?${params.toString()}`,
      callbackScheme: CALLBACK_SCHEME,
      ephemeral: options.ephemeral,
    })
    if (callback === null) return { kind: 'cancelled' }
    options.onSheetClosed?.()

    const result = new URL(callback).searchParams
    const code = result.get('code')
    if (result.get('state') !== oauthState || code === null) {
      throw new AppError('auth', 'Reflect Classic returned an invalid sign-in callback')
    }
    const token = await this.#exchangeCode(code, verifier)
    const now = clock.now()
    const { email, expiresAt } = await this.#checkClassicAccount(token, now)
    if (expiresAt === null) return { kind: 'not-eligible', email }

    const access = { token, email, expiresAt, checkedAt: now }
    await this.#saveAccess(access)
    return { kind: 'signed-in', access }
  }

  async signOut(): Promise<void> {
    await this.#deps.secretStore.delete(CLASSIC_ACCESS_SECRET)
    this.#publish(null)
  }

  start(): Unlisten {
    const { activity, platform, logger } = this.#deps
    if (platform.appPlatform !== 'ios') return () => {}
    this.read().catch((error: unknown) => {
      logger.error('Reading the Reflect Classic access failed', error)
    })
    let stopRechecks: Unlisten | null = null
    const followToken = (): void => {
      const hasToken = this.#state.access?.token != null
      if (hasToken && stopRechecks === null) {
        const recheckNow = (): void => {
          this.load().catch((error: unknown) => {
            logger.error('Reading the Reflect Classic access failed', error)
          })
        }
        recheckNow()
        stopRechecks = activity.subscribeVisible(recheckNow)
      } else if (!hasToken && stopRechecks !== null) {
        stopRechecks()
        stopRechecks = null
      }
    }
    followToken()
    const unsubscribe = this.subscribe(followToken)
    return () => {
      unsubscribe()
      stopRechecks?.()
    }
  }

  #publish(access: ClassicAccess | null): void {
    this.#state = {
      access,
      active: access !== null && isClassicAccessActive(access, this.#deps.clock.now()),
      isLoading: false,
    }
    for (const listener of this.#listeners) {
      listener()
    }
  }

  async #send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#deps.http.fetch(`${CLASSIC_ORIGIN}${path}`, init)
    } catch (error) {
      throw new AppError('network', `Could not reach Reflect Classic (${path})`, {
        cause: error,
      })
    }
  }

  /**
   * Validates a Reflect Classic response. A non-2xx status throws `failure`; a
   * body that is not JSON or does not match `schema` throws `parse`. Each case
   * logs its own warning.
   */
  async #readResponse<T>(
    response: Response,
    path: string,
    schema: z.ZodType<T>,
    failure: 'auth' | 'network',
  ): Promise<T> {
    const { logger } = this.#deps
    if (!response.ok) {
      logger.warn(`Reflect Classic answered ${response.status} (${path})`)
      throw new AppError(failure, `Reflect Classic answered ${response.status} (${path})`)
    }
    let json: unknown
    try {
      json = await response.json()
    } catch (error) {
      logger.warn(`Reflect Classic returned a body that is not JSON (${path})`, error)
      throw new AppError('parse', `Reflect Classic returned a body that is not JSON (${path})`, {
        cause: error,
      })
    }
    const body = schema.safeParse(json)
    if (!body.success) {
      logger.warn(`Reflect Classic returned an unexpected body (${path})`, body.error)
      throw new AppError('parse', `Reflect Classic returned an unexpected body (${path})`, {
        cause: body.error,
      })
    }
    return body.data
  }

  async #exchangeCode(code: string, verifier: string): Promise<string> {
    const response = await this.#send('/api/oauth/token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLASSIC_OAUTH_CLIENT_ID, code, code_verifier: verifier }),
    })
    const body = await this.#readResponse(response, '/api/oauth/token', tokenSchema, 'auth')
    return body.access_token
  }

  async #getWithToken<T>(token: string, path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await this.#send(path, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    })
    if (response.status === 401) {
      throw new AppError('auth', `Reflect Classic rejected the stored token (${path})`)
    }
    return await this.#readResponse(response, path, schema, 'network')
  }

  /**
   * Reads the account and works out until when it unlocks Reflect Open.
   */
  async #checkClassicAccount(
    token: string,
    now: number,
  ): Promise<{ email: string | null; expiresAt: number | null }> {
    const me = await this.#getWithToken(token, '/api/users/me', meSchema)
    const invoices = me.subscription.paid
      ? []
      : (await this.#getWithToken(token, '/api/users/me/invoices', invoicesSchema)).invoices
    return { email: me.email, expiresAt: classicAccessUntil(me.subscription.paid, invoices, now) }
  }

  async #saveAccess(access: ClassicAccess): Promise<void> {
    await this.#deps.secretStore.set(CLASSIC_ACCESS_SECRET, JSON.stringify(access))
  }

  async #readStored(): Promise<ClassicAccess | null> {
    const raw = await this.#deps.secretStore.get(CLASSIC_ACCESS_SECRET)
    if (raw === null) return null
    try {
      return classicAccessSchema.parse(JSON.parse(raw))
    } catch (error) {
      this.#deps.logger.error('Ignoring an unreadable Reflect Classic access record', error)
      return null
    }
  }

  async #recheck(): Promise<ClassicAccess | null> {
    const { clock, logger } = this.#deps
    const stored = await this.#readStored()
    if (stored === null || stored.token === null) return stored
    if (clock.now() - stored.checkedAt < RECHECK_INTERVAL_MS) return stored

    try {
      const now = clock.now()
      const account = await this.#checkClassicAccount(stored.token, now)
      const next = {
        ...stored,
        email: account.email,
        expiresAt: account.expiresAt ?? stored.expiresAt,
        checkedAt: now,
      }
      await this.#saveAccess(next)
      return next
    } catch (error: unknown) {
      if (isAppError(error) && error.kind === 'auth') {
        logger.warn('Reflect Classic rejected the stored token; keeping the current expiry', error)
        const next = { ...stored, token: null }
        await this.#saveAccess(next)
        return next
      }
      logger.warn('Checking the Reflect Classic subscription failed; will retry later', error)
      return stored
    }
  }

  async #settle(lookup: Promise<ClassicAccess | null>): Promise<ClassicAccess | null> {
    try {
      const access = await lookup
      this.#publish(access)
      return access
    } catch (error) {
      if (this.#state.isLoading) {
        this.#state = { ...this.#state, isLoading: false }
        for (const listener of this.#listeners) {
          listener()
        }
      }
      throw error
    }
  }
}

export function createClassicAccessService(deps: ClassicAccessServiceDeps): ClassicAccessService {
  return new ClassicAccessServiceImpl(deps)
}
