import { z } from 'zod'
import { getLocalStorageStore } from '@/lib/local-storage'

export const appStoreEnvironmentSchema = z.enum(['Production', 'Sandbox', 'Xcode']).nullable()
export type AppStoreEnvironment = z.infer<typeof appStoreEnvironmentSchema>

export const activeSubscriptionSchema = z.enum(['yearly', 'monthly']).nullable()
export type ActiveSubscription = z.infer<typeof activeSubscriptionSchema>

export const activeSubscriptionSeedSchema = z.object({
  value: activeSubscriptionSchema,
  updatedAt: z.number(),
})
export type ActiveSubscriptionSeed = z.infer<typeof activeSubscriptionSeedSchema>

export const IAP_ENVIRONMENT_STORAGE_KEY = 'reflect.iap.environment'
export const ACTIVE_SUBSCRIPTION_STORAGE_KEY = 'reflect.iap.active-subscription'

const ACTIVE_SUBSCRIPTION_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000

function readStoredValue<T>(key: string, schema: z.ZodType<T>): T | undefined {
  try {
    const parsed: unknown = JSON.parse(getLocalStorageStore(key).get() ?? '')
    const result = schema.safeParse(parsed)
    return result.success ? result.data : undefined
  } catch {
    return undefined
  }
}

function writeStoredValue<T>(key: string, schema: z.ZodType<T>, value: T): void {
  const parsed = schema.safeParse(value)
  if (parsed.success) {
    getLocalStorageStore(key).set(JSON.stringify(parsed.data))
  }
}

export function readIapEnvironmentSeed(): AppStoreEnvironment | undefined {
  return readStoredValue(IAP_ENVIRONMENT_STORAGE_KEY, appStoreEnvironmentSchema)
}

export function writeIapEnvironmentSeed(value: AppStoreEnvironment): void {
  writeStoredValue(IAP_ENVIRONMENT_STORAGE_KEY, appStoreEnvironmentSchema, value)
}

export function readActiveSubscriptionSeed(): ActiveSubscriptionSeed | undefined {
  const seed = readStoredValue(ACTIVE_SUBSCRIPTION_STORAGE_KEY, activeSubscriptionSeedSchema)
  return seed !== undefined && Date.now() - seed.updatedAt <= ACTIVE_SUBSCRIPTION_MAX_AGE_MS
    ? seed
    : undefined
}

export function writeActiveSubscriptionSeed(value: ActiveSubscription): void {
  writeStoredValue(ACTIVE_SUBSCRIPTION_STORAGE_KEY, activeSubscriptionSeedSchema, {
    value,
    updatedAt: Date.now(),
  })
}
