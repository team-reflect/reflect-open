import { z } from 'zod'

export const appStoreEnvironmentSchema = z.enum(['Production', 'Sandbox', 'Xcode']).nullable()
export type AppStoreEnvironment = z.infer<typeof appStoreEnvironmentSchema>

export const activeSubscriptionSchema = z.enum(['yearly', 'monthly']).nullable()
export type ActiveSubscription = z.infer<typeof activeSubscriptionSchema>

export const activeSubscriptionSeedSchema = z.object({
  value: activeSubscriptionSchema,
  updatedAt: z.number(),
})
export interface ActiveSubscriptionSeed {
  readonly value: ActiveSubscription
  readonly updatedAt: number
}

export const IAP_ENVIRONMENT_STORAGE_KEY = 'reflect.iap.environment'
export const ACTIVE_SUBSCRIPTION_STORAGE_KEY = 'reflect.iap.active-subscription'

const ACTIVE_SUBSCRIPTION_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000

function localStorageOrNull(): Storage | null {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    return window.localStorage
  } catch (error) {
    console.error('reaching IAP storage failed', error)
    return null
  }
}

function readStoredValue<T>(key: string, schema: z.ZodType<T>): T | undefined {
  const storage = localStorageOrNull()
  if (storage === null) {
    return undefined
  }

  let rawValue: string | null
  try {
    rawValue = storage.getItem(key)
  } catch (error) {
    console.error('reading IAP storage failed', key, error)
    return undefined
  }
  if (rawValue === null) {
    return undefined
  }

  try {
    const parsed: unknown = JSON.parse(rawValue)
    const result = schema.safeParse(parsed)
    return result.success ? result.data : undefined
  } catch {
    return undefined
  }
}

function writeStoredValue<T>(key: string, schema: z.ZodType<T>, value: T): void {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    return
  }
  const storage = localStorageOrNull()
  if (storage === null) {
    return
  }
  try {
    storage.setItem(key, JSON.stringify(parsed.data))
  } catch (error) {
    console.error('writing IAP storage failed', key, error)
  }
}

/** Read the last validated install channel, or undefined when no valid seed exists. */
export function readIapEnvironmentSeed(): AppStoreEnvironment | undefined {
  return readStoredValue(IAP_ENVIRONMENT_STORAGE_KEY, appStoreEnvironmentSchema)
}

/** Persist a validated install channel for the next launch. */
export function writeIapEnvironmentSeed(value: AppStoreEnvironment): void {
  writeStoredValue(IAP_ENVIRONMENT_STORAGE_KEY, appStoreEnvironmentSchema, value)
}

/** Read a fresh validated entitlement seed, or undefined when missing, invalid, or expired. */
export function readActiveSubscriptionSeed(): ActiveSubscriptionSeed | undefined {
  const seed = readStoredValue(ACTIVE_SUBSCRIPTION_STORAGE_KEY, activeSubscriptionSeedSchema)
  if (seed === undefined || Date.now() - seed.updatedAt > ACTIVE_SUBSCRIPTION_MAX_AGE_MS) {
    return undefined
  }
  return seed
}

/** Persist a validated entitlement answer with its write time for the next launch. */
export function writeActiveSubscriptionSeed(value: ActiveSubscription): void {
  writeStoredValue(ACTIVE_SUBSCRIPTION_STORAGE_KEY, activeSubscriptionSeedSchema, {
    value,
    updatedAt: Date.now(),
  })
}
