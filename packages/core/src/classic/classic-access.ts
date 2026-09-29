import pkceChallenge from 'pkce-challenge'
import { z } from 'zod'
import { ReflectError } from '../errors.ts'
import { deleteSecret, getSecret, setSecret } from '../secrets/keychain.ts'

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
/** How long Reflect Open stays usable after the last paid Classic period. */
const ACCESS_AFTER_PAYMENT_MS = 365 * DAY_MS

/** The keychain entry holding this device's Reflect Classic access. */
export const CLASSIC_ACCESS_SECRET = 'reflect-classic-access'

export const classicAccessSchema = z.object({
  /** The Reflect Classic OAuth access token; null once Classic rejects it. */
  token: z.string().nullable(),
  email: z.string().nullable(),
  /** Epoch ms. */
  expiresAt: z.number(),
  /** Epoch ms of the last successful check with Reflect Classic. */
  checkedAt: z.number(),
})
export type ClassicAccess = z.infer<typeof classicAccessSchema>

export type ClassicSignInResult =
  | { kind: 'cancelled' }
  | { kind: 'not-eligible' }
  | { kind: 'signed-in'; access: ClassicAccess }

/** Opens the system web sign-in and resolves its callback URL, or `null` when cancelled. */
export type StartWebAuth = (options: {
  url: string
  callbackScheme: string
  ephemeral: boolean
}) => Promise<string | null>

const meSchema = z.object({
  email: z.string().nullable(),
  subscription: z.object({ paid: z.boolean() }),
})

const invoiceSchema = z.object({
  status: z.string().nullable(),
  amount_paid: z.number(),
  amount_refunded: z.number(),
  lines: z.array(z.object({ period_end: z.string() })),
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

async function send(fetchFn: typeof fetch, path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchFn(`${CLASSIC_ORIGIN}${path}`, init)
  } catch (error) {
    throw new ReflectError('network', `Could not reach Reflect Classic (${path})`, { cause: error })
  }
}

/**
 * Validates a Reflect Classic response. A non-2xx status throws `failure`; a
 * body that is not JSON or does not match `schema` throws `parse`. Each case
 * logs its own warning.
 */
async function readResponse<T>(
  response: Response,
  path: string,
  schema: z.ZodType<T>,
  failure: 'auth' | 'network',
): Promise<T> {
  if (!response.ok) {
    console.warn(`Reflect Classic answered ${response.status} (${path})`)
    throw new ReflectError(failure, `Reflect Classic answered ${response.status} (${path})`)
  }
  let json: unknown
  try {
    json = await response.json()
  } catch (error) {
    console.warn(`Reflect Classic returned a body that is not JSON (${path})`, error)
    throw new ReflectError('parse', `Reflect Classic returned a body that is not JSON (${path})`, {
      cause: error,
    })
  }
  const body = schema.safeParse(json)
  if (!body.success) {
    console.warn(`Reflect Classic returned an unexpected body (${path})`, body.error)
    throw new ReflectError('parse', `Reflect Classic returned an unexpected body (${path})`, {
      cause: body.error,
    })
  }
  return body.data
}

async function exchangeCode(
  code: string,
  verifier: string,
  fetchFn: typeof fetch,
): Promise<string> {
  const response = await send(fetchFn, '/api/oauth/token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLASSIC_OAUTH_CLIENT_ID, code, code_verifier: verifier }),
  })
  const body = await readResponse(response, '/api/oauth/token', tokenSchema, 'auth')
  return body.access_token
}

async function getWithToken<T>(
  fetchFn: typeof fetch,
  token: string,
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await send(fetchFn, path, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  })
  if (response.status === 401) {
    throw new ReflectError('auth', `Reflect Classic rejected the stored token (${path})`)
  }
  return await readResponse(response, path, schema, 'network')
}

/** Reads the account and works out until when it unlocks Reflect Open. */
async function checkClassicAccount(
  fetchFn: typeof fetch,
  token: string,
  now: number,
): Promise<{ email: string | null; expiresAt: number | null }> {
  const me = await getWithToken(fetchFn, token, '/api/users/me', meSchema)
  const invoices = me.subscription.paid
    ? []
    : (await getWithToken(fetchFn, token, '/api/users/me/invoices', invoicesSchema)).invoices
  return { email: me.email, expiresAt: classicAccessUntil(me.subscription.paid, invoices, now) }
}

async function saveAccess(access: ClassicAccess): Promise<void> {
  await setSecret(CLASSIC_ACCESS_SECRET, JSON.stringify(access))
}

async function readAccess(): Promise<ClassicAccess | null> {
  const raw = await getSecret(CLASSIC_ACCESS_SECRET)
  if (raw === null) return null
  try {
    return classicAccessSchema.parse(JSON.parse(raw))
  } catch (error) {
    console.error('Ignoring an unreadable Reflect Classic access record', error)
    return null
  }
}

/** Sign in to Reflect Classic and store the access it grants on this device. */
export async function signInWithClassic(options: {
  ephemeral: boolean
  fetchFn: typeof fetch
  startWebAuth: StartWebAuth
}): Promise<ClassicSignInResult> {
  const { code_verifier: verifier, code_challenge: challenge } = await pkceChallenge()
  const state = crypto.randomUUID()
  const params = new URLSearchParams({
    client_id: CLASSIC_OAUTH_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  const callback = await options.startWebAuth({
    url: `${CLASSIC_ORIGIN}/oauth?${params.toString()}`,
    callbackScheme: CALLBACK_SCHEME,
    ephemeral: options.ephemeral,
  })
  if (callback === null) return { kind: 'cancelled' }

  const result = new URL(callback).searchParams
  const code = result.get('code')
  if (result.get('state') !== state || code === null) {
    throw new ReflectError('auth', 'Reflect Classic returned an invalid sign-in callback')
  }
  const token = await exchangeCode(code, verifier, options.fetchFn)
  const now = Date.now()
  const { email, expiresAt } = await checkClassicAccount(options.fetchFn, token, now)
  if (expiresAt === null) return { kind: 'not-eligible' }

  const access = { token, email, expiresAt, checkedAt: now }
  await saveAccess(access)
  return { kind: 'signed-in', access }
}

/**
 * This device's stored access, rechecked with Reflect Classic when the last
 * successful check is more than a day old. A failed recheck keeps the stored
 * answer, so being offline never locks the app early.
 */
export async function loadClassicAccess(fetchFn: typeof fetch): Promise<ClassicAccess | null> {
  const stored = await readAccess()
  if (stored === null || stored.token === null) return stored
  if (Date.now() - stored.checkedAt < RECHECK_INTERVAL_MS) return stored

  try {
    const now = Date.now()
    const account = await checkClassicAccount(fetchFn, stored.token, now)
    const next = {
      ...stored,
      email: account.email,
      expiresAt: account.expiresAt ?? stored.expiresAt,
      checkedAt: now,
    }
    await saveAccess(next)
    return next
  } catch (error: unknown) {
    if (error instanceof ReflectError && error.kind === 'auth') {
      console.warn('Reflect Classic rejected the stored token; keeping the current expiry', error)
      const next = { ...stored, token: null }
      await saveAccess(next)
      return next
    }
    console.warn('Checking the Reflect Classic subscription failed; will retry later', error)
    return stored
  }
}

export async function clearClassicAccess(): Promise<void> {
  await deleteSecret(CLASSIC_ACCESS_SECRET)
}
