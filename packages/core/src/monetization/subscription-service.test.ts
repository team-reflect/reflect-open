import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IAP_PRODUCT_IDS } from '../ipc/iap-service.ts'
import { createTestClockService, type TestClockService } from '../testing/clock.ts'
import { createTestLoggerService, type TestLoggerService } from '../testing/logger.ts'
import { createTestPlatformService } from '../testing/platform.ts'
import { createTestIapService, type TestIapService } from '../testing/plugins.ts'
import { createTestStorageService, type TestStorageService } from '../testing/storage.ts'
import {
  ACTIVE_SUBSCRIPTION_STORAGE_KEY,
  createSubscriptionService,
  type SubscriptionService,
} from './subscription-service.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 1)

let clock: TestClockService
let storage: TestStorageService
let logger: TestLoggerService
let iap: TestIapService
/**
 * What StoreKit says about each product id.
 */
let owned: (productId: string) => Promise<boolean>
let lookups: string[]

function never<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

beforeEach(() => {
  clock = createTestClockService({ now: NOW })
  storage = createTestStorageService()
  logger = createTestLoggerService()
  owned = () => Promise.resolve(false)
  lookups = []
  const base = createTestIapService()
  const spy = vi.spyOn(base, 'isOwned')
  spy.mockImplementation((productId) => {
    lookups.push(productId)
    return owned(productId)
  })
  iap = base
})

function seed(value: 'yearly' | 'monthly' | null, updatedAt: number): void {
  storage.local.set(ACTIVE_SUBSCRIPTION_STORAGE_KEY, JSON.stringify({ value, updatedAt }))
}

function storedSeed(): unknown {
  return JSON.parse(storage.local.get(ACTIVE_SUBSCRIPTION_STORAGE_KEY) ?? 'null')
}

function service(appPlatform: 'ios' | 'desktop' = 'ios'): SubscriptionService {
  return createSubscriptionService({
    iap,
    storage,
    clock,
    platform: createTestPlatformService({ appPlatform }),
    logger,
  })
}

describe('SubscriptionService', () => {
  it('starts loading without a seed and settles on the StoreKit answer', async () => {
    const subscription = service()
    expect(subscription.getState()).toEqual({ value: null, isLoading: true, isError: false })

    await expect(subscription.activeSubscription()).resolves.toBeNull()

    expect(subscription.getState()).toEqual({ value: null, isLoading: false, isError: false })
    expect(lookups.toSorted()).toEqual([IAP_PRODUCT_IDS.monthly, IAP_PRODUCT_IDS.yearly])
    expect(storedSeed()).toEqual({ value: null, updatedAt: NOW })
  })

  it('names the plan StoreKit confirms and remembers it', async () => {
    owned = (productId) => Promise.resolve(productId === IAP_PRODUCT_IDS.monthly)
    const subscription = service()

    await expect(subscription.activeSubscription()).resolves.toBe('monthly')
    expect(subscription.getState().value).toBe('monthly')
    expect(storedSeed()).toEqual({ value: 'monthly', updatedAt: NOW })
  })

  it('takes either confirmed plan without waiting on its sibling', async () => {
    owned = (productId) =>
      productId === IAP_PRODUCT_IDS.yearly ? Promise.resolve(true) : never<boolean>()
    await expect(service().activeSubscription()).resolves.toBe('yearly')
  })

  it('answers from a seed of the last two days before StoreKit says anything', () => {
    seed('yearly', NOW - 2 * DAY_MS)
    owned = never
    expect(service().getState()).toEqual({ value: 'yearly', isLoading: false, isError: false })
  })

  it('ignores a seed older than two days', () => {
    seed('yearly', NOW - 2 * DAY_MS - 1)
    expect(service().getState()).toEqual({ value: null, isLoading: true, isError: false })
  })

  it('keeps loading while it verifies a remembered null', () => {
    seed(null, NOW)
    expect(service().getState().isLoading).toBe(true)
  })

  it('lets the live answer overrule a subscription that lapsed', async () => {
    seed('yearly', NOW)
    const subscription = service()

    await subscription.activeSubscription()

    expect(subscription.getState().value).toBeNull()
    expect(storedSeed()).toEqual({ value: null, updatedAt: NOW })
  })

  it('times each lookup out after 15 seconds, retries once, and joins the pending lookups', async () => {
    owned = never
    const subscription = service()
    const answer = subscription.activeSubscription()
    expect(lookups).toHaveLength(2)

    await clock.advance(15_000)
    expect(subscription.getState().isLoading).toBe(true)
    await clock.advance(1000)
    expect(lookups).toHaveLength(2)
    await clock.advance(15_000)

    await expect(answer).resolves.toBeNull()
    expect(subscription.getState()).toEqual({ value: null, isLoading: false, isError: true })
    expect(logger.getWarnings()).toEqual([
      { message: 'Looking up the App Store subscription failed', cause: expect.any(Error) },
    ])
    expect(lookups).toHaveLength(2)
    expect(storage.local.get(ACTIVE_SUBSCRIPTION_STORAGE_KEY)).toBeNull()
  })

  it('shares the pending native lookups with a second refetch', () => {
    owned = never
    const subscription = service()
    void subscription.refetch()
    void subscription.refetch()
    expect(lookups).toHaveLength(2)
  })

  it('does not remember null when one lookup fails and the sibling is negative', async () => {
    seed('yearly', NOW)
    owned = (productId) =>
      productId === IAP_PRODUCT_IDS.yearly
        ? Promise.reject(new Error('StoreKit unavailable'))
        : Promise.resolve(false)
    const subscription = service()

    const answer = subscription.activeSubscription()
    await clock.advance(1000)

    await expect(answer).resolves.toBe('yearly')
    expect(subscription.getState()).toEqual({ value: 'yearly', isLoading: false, isError: false })
    expect(storedSeed()).toEqual({ value: 'yearly', updatedAt: NOW })
  })

  it('reuses a live answer for a minute', async () => {
    const subscription = service()
    await subscription.activeSubscription()
    await subscription.activeSubscription()
    expect(lookups).toHaveLength(2)

    await clock.advance(60_000)
    await subscription.activeSubscription()
    expect(lookups).toHaveLength(4)
  })

  it('always looks up again on refetch', async () => {
    const subscription = service()
    await subscription.activeSubscription()
    owned = (productId) => Promise.resolve(productId === IAP_PRODUCT_IDS.yearly)

    await expect(subscription.refetch()).resolves.toBe('yearly')
    expect(lookups).toHaveLength(4)
  })

  it('looks up again after a purchase update while subscribed', async () => {
    const subscription = service()
    await subscription.activeSubscription()
    let notified = 0
    subscription.subscribe(() => {
      notified += 1
    })

    owned = (productId) => Promise.resolve(productId === IAP_PRODUCT_IDS.monthly)
    iap.emitPurchaseUpdated()

    await clock.advance(0)
    expect(subscription.getState().value).toBe('monthly')
    expect(notified).toBe(1)
  })

  it('only marks the answer stale when nobody is subscribed', async () => {
    const subscription = service()
    await subscription.activeSubscription()

    subscription.invalidate()
    expect(lookups).toHaveLength(2)

    await subscription.activeSubscription()
    expect(lookups).toHaveLength(4)
  })

  it('stays out of the way off iOS', async () => {
    seed('yearly', NOW)
    const subscription = service('desktop')

    expect(subscription.getState()).toEqual({ value: null, isLoading: false, isError: false })
    await expect(subscription.activeSubscription()).resolves.toBeNull()
    iap.emitPurchaseUpdated()
    expect(lookups).toEqual([])
  })
})
