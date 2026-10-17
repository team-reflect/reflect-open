import { z } from 'zod'
import type { ClockService } from '../ports/clock-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { PlatformFacts } from '../ports/platform-facts.ts'
import { getJson, setJson, type StorageService } from '../ports/storage-service.ts'
import { IAP_PRODUCT_IDS, type IapService } from '../ipc/iap-service.ts'
import type { Unlisten } from '../unlisten.ts'
import { toAppError } from '../errors.ts'

const activeSubscriptionSchema = z.enum(['yearly', 'monthly']).nullable()

/**
 * The App Store subscription this device owns, or `null` for none.
 */
export type ActiveSubscription = z.infer<typeof activeSubscriptionSchema>

type SubscriptionPlan = Exclude<ActiveSubscription, null>

const activeSubscriptionSeedSchema = z.object({
  value: activeSubscriptionSchema,
  updatedAt: z.number(),
})

export const ACTIVE_SUBSCRIPTION_STORAGE_KEY = 'reflect.iap.active-subscription'
const ACTIVE_SUBSCRIPTION_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000
const ENTITLEMENT_LOOKUP_TIMEOUT_MS = 15_000
/**
 * How long a live answer counts as fresh for `activeSubscription`.
 */
const FRESH_MS = 60_000
/**
 * A failed lookup is retried once after this delay.
 */
const RETRY_DELAY_MS = 1000

export interface SubscriptionState {
  /**
   * The live answer, else a seed from the last two days, else `null`.
   */
  readonly value: ActiveSubscription
  /**
   * True while no plan is known and this launch has no settled answer yet.
   */
  readonly isLoading: boolean
  /**
   * True when the last lookup failed and no plan is known.
   */
  readonly isError: boolean
}

/**
 * The current App Store subscription, seeded from the last launch.
 */
export interface SubscriptionService {
  getState: () => SubscriptionState
  subscribe: (listener: () => void) => Unlisten
  /**
   * The subscription, looked up in StoreKit unless a live answer is less than
   * a minute old. A failed lookup resolves the current value and shows in
   * `getState().isError`.
   */
  activeSubscription(): Promise<ActiveSubscription>
  /**
   * Looks the subscription up in StoreKit now and resolves the current value.
   */
  refetch: () => Promise<ActiveSubscription>
  /**
   * Marks the answer stale, and looks it up again while anyone is subscribed.
   */
  invalidate: () => void
}

const IDLE_STATE: SubscriptionState = { value: null, isLoading: false, isError: false }

/** A lookup that found no plan rejects with this, so `Promise.any` skips it. */
class NoPlanError extends Error {}

/**
 * Resolves the first plan that a lookup confirms, else `null` once every
 * lookup settles, else an `AggregateError` of every lookup failure.
 */
async function resolveActiveSubscription(
  lookups: readonly Promise<SubscriptionPlan | null>[],
): Promise<ActiveSubscription> {
  try {
    return await Promise.any(
      lookups.map(async (lookup) => {
        const plan = await lookup
        if (plan === null) {
          throw new NoPlanError()
        }
        return plan
      }),
    )
  } catch (error) {
    if (!(error instanceof AggregateError)) {
      throw error
    }
    const failures = error.errors.filter((reason) => !(reason instanceof NoPlanError))
    if (failures.length === 0) {
      return null
    }
    throw new AggregateError(failures, 'every App Store subscription lookup failed')
  }
}

export interface SubscriptionServiceDeps {
  readonly iap: IapService
  readonly storage: StorageService
  readonly clock: ClockService
  readonly platform: PlatformFacts
  readonly logger: LoggerService
}

class SubscriptionServiceImpl implements SubscriptionService {
  readonly #deps: SubscriptionServiceDeps
  readonly #enabled: boolean
  readonly #listeners = new Set<() => void>()
  readonly #pendingEntitlementLookups = new Map<string, Promise<boolean>>()
  #value: ActiveSubscription = null
  /**
   * Epoch ms of the last live answer, or `null` before one or after `invalidate`.
   */
  #answeredAt: number | null = null
  #hasLiveAnswer = false
  #settled = false
  #fetching = false
  #failed = false
  #pendingRun: Promise<ActiveSubscription> | null = null
  #state: SubscriptionState = IDLE_STATE

  constructor(deps: SubscriptionServiceDeps) {
    this.#deps = deps
    const { iap, storage, clock, platform } = deps
    this.#enabled = platform.appPlatform === 'ios'
    if (this.#enabled) {
      const seed = getJson(
        storage.local,
        ACTIVE_SUBSCRIPTION_STORAGE_KEY,
        activeSubscriptionSeedSchema,
      )
      if (seed !== undefined && clock.now() - seed.updatedAt <= ACTIVE_SUBSCRIPTION_MAX_AGE_MS) {
        this.#value = seed.value
      }
      this.#state = this.#computeState()
      iap.subscribePurchaseUpdated(this.invalidate)
    }
  }

  readonly getState = (): SubscriptionState => this.#state

  readonly subscribe = (listener: () => void): Unlisten => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  activeSubscription(): Promise<ActiveSubscription> {
    if (this.#answeredAt !== null && this.#deps.clock.now() - this.#answeredAt < FRESH_MS) {
      return Promise.resolve(this.#value)
    }
    return this.refetch()
  }

  readonly refetch = (): Promise<ActiveSubscription> => {
    if (!this.#enabled) {
      return Promise.resolve(null)
    }
    if (this.#pendingRun === null) {
      const current = this.#run()
      this.#pendingRun = current
      void current.finally(() => {
        if (this.#pendingRun === current) this.#pendingRun = null
      })
    }
    return this.#pendingRun
  }

  readonly invalidate = (): void => {
    this.#answeredAt = null
    if (this.#listeners.size > 0) {
      void this.refetch()
    }
  }

  #computeState(): SubscriptionState {
    return {
      value: this.#value,
      isLoading: this.#value === null && !this.#hasLiveAnswer && (this.#fetching || !this.#settled),
      isError: this.#failed && this.#value === null,
    }
  }

  #publish(): void {
    const next = this.#computeState()
    const state = this.#state
    if (
      next.value === state.value &&
      next.isLoading === state.isLoading &&
      next.isError === state.isError
    ) {
      return
    }
    this.#state = next
    for (const listener of this.#listeners) {
      listener()
    }
  }

  #withEntitlementTimeout(operation: Promise<boolean>): Promise<boolean> {
    const { clock } = this.#deps
    return new Promise((resolve, reject) => {
      const timeout = clock.setTimeout(() => {
        reject(new Error('StoreKit entitlement lookup timed out'))
      }, ENTITLEMENT_LOOKUP_TIMEOUT_MS)

      void operation.then(
        (owned) => {
          clock.clearTimeout(timeout)
          resolve(owned)
        },
        (error: unknown) => {
          clock.clearTimeout(timeout)
          reject(toAppError(error))
        },
      )
    })
  }

  #lookupEntitlement(productId: string): Promise<boolean> {
    const pending = this.#pendingEntitlementLookups.get(productId)
    if (pending !== undefined) {
      return pending
    }

    const lookup = this.#deps.iap.isOwned(productId)
    this.#pendingEntitlementLookups.set(productId, lookup)
    const clearPendingLookup = (): void => {
      if (this.#pendingEntitlementLookups.get(productId) === lookup) {
        this.#pendingEntitlementLookups.delete(productId)
      }
    }
    void lookup.then(clearPendingLookup, clearPendingLookup)
    return lookup
  }

  async #lookupOnce(): Promise<ActiveSubscription> {
    return await resolveActiveSubscription([
      this.#withEntitlementTimeout(this.#lookupEntitlement(IAP_PRODUCT_IDS.yearly)).then((owned) =>
        owned ? 'yearly' : null,
      ),
      this.#withEntitlementTimeout(this.#lookupEntitlement(IAP_PRODUCT_IDS.monthly)).then(
        (owned) => (owned ? 'monthly' : null),
      ),
    ])
  }

  async #lookupWithRetry(): Promise<ActiveSubscription> {
    try {
      return await this.#lookupOnce()
    } catch {
      await this.#deps.clock.sleep(RETRY_DELAY_MS)
      return await this.#lookupOnce()
    }
  }

  async #run(): Promise<ActiveSubscription> {
    const { storage, clock, logger } = this.#deps
    this.#fetching = true
    this.#publish()
    try {
      const next = await this.#lookupWithRetry()
      this.#value = next
      this.#hasLiveAnswer = true
      this.#answeredAt = clock.now()
      this.#failed = false
      setJson(storage.local, ACTIVE_SUBSCRIPTION_STORAGE_KEY, activeSubscriptionSeedSchema, {
        value: next,
        updatedAt: clock.now(),
      })
    } catch (error) {
      this.#failed = true
      logger.warn('Looking up the App Store subscription failed', error)
    } finally {
      this.#fetching = false
      this.#settled = true
      this.#publish()
    }
    return this.#value
  }
}

export function createSubscriptionService(deps: SubscriptionServiceDeps): SubscriptionService {
  return new SubscriptionServiceImpl(deps)
}
