import { useEffect } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { IAP_PRODUCT_IDS, iapIsOwned, subscribeIapPurchaseUpdated } from '@reflect/core'
import { z } from 'zod'
import { getLocalStorageStore } from '@/lib/local-storage'
import { queryKeys } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'

const activeSubscriptionSchema = z.enum(['yearly', 'monthly']).nullable()
type ActiveSubscription = z.infer<typeof activeSubscriptionSchema>

const activeSubscriptionSeedSchema = z.object({
  value: activeSubscriptionSchema,
  updatedAt: z.number(),
})
const ACTIVE_SUBSCRIPTION_STORAGE_KEY = 'reflect.iap.active-subscription'
const ACTIVE_SUBSCRIPTION_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000
const ENTITLEMENT_LOOKUP_TIMEOUT_MS = 5_000

type SubscriptionPlan = Exclude<ActiveSubscription, null>

function readActiveSubscriptionSeed(): ActiveSubscription | undefined {
  const seed = getLocalStorageStore(ACTIVE_SUBSCRIPTION_STORAGE_KEY).getJson(
    activeSubscriptionSeedSchema,
  )
  return seed !== undefined && Date.now() - seed.updatedAt <= ACTIVE_SUBSCRIPTION_MAX_AGE_MS
    ? seed.value
    : undefined
}

function writeActiveSubscriptionSeed(value: ActiveSubscription): void {
  getLocalStorageStore(ACTIVE_SUBSCRIPTION_STORAGE_KEY).setJson(activeSubscriptionSeedSchema, {
    value,
    updatedAt: Date.now(),
  })
}

function withEntitlementTimeout(operation: Promise<boolean>): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('StoreKit entitlement lookup timed out'))
    }, ENTITLEMENT_LOOKUP_TIMEOUT_MS)

    void operation.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

function resolveActiveSubscription(
  lookups: readonly Promise<SubscriptionPlan | null>[],
): Promise<ActiveSubscription> {
  return new Promise((resolve, reject) => {
    let pending = lookups.length
    const errors: unknown[] = []

    function settleEmptyLookup(): void {
      pending -= 1
      if (pending !== 0) {
        return
      }
      if (errors.length > 0) {
        reject(errors[0])
      } else {
        resolve(null)
      }
    }

    for (const lookup of lookups) {
      void lookup.then(
        (plan) => {
          if (plan !== null) {
            resolve(plan)
            return
          }
          settleEmptyLookup()
        },
        (error: unknown) => {
          errors.push(error)
          settleEmptyLookup()
        },
      )
    }
  })
}

async function fetchActiveSubscription(): Promise<ActiveSubscription> {
  const subscription = await resolveActiveSubscription([
    withEntitlementTimeout(iapIsOwned(IAP_PRODUCT_IDS.yearly)).then((owned) =>
      owned ? 'yearly' : null,
    ),
    withEntitlementTimeout(iapIsOwned(IAP_PRODUCT_IDS.monthly)).then((owned) =>
      owned ? 'monthly' : null,
    ),
  ])
  writeActiveSubscriptionSeed(subscription)
  return subscription
}

/** Invalidate both entitlement products through their shared prefix. */
export async function invalidateEntitlements(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: queryKeys.iap.entitlements })
}

/** The live or startup-seeded active subscription. */
export function useActiveSubscription(): {
  value: ActiveSubscription
  isLoading: boolean
  isError: boolean
  invalidate: VoidFunction
} {
  const { platform } = useGraph()
  const enabled = platform === 'ios'
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: queryKeys.iap.entitlements,
    queryFn: fetchActiveSubscription,
    initialData: readActiveSubscriptionSeed,
    initialDataUpdatedAt: 0,
    staleTime: 60_000,
    refetchOnWindowFocus: 'always',
    retry: false,
    enabled,
  })

  useEffect(() => {
    if (!enabled) {
      return
    }
    const subscription = subscribeIapPurchaseUpdated(() => {
      void invalidateEntitlements(queryClient)
    })
    subscription.ready.catch((error: unknown) => {
      console.error('subscribing to purchaseUpdated failed', error)
    })
    return subscription.unlisten
  }, [enabled, queryClient])

  return {
    value: query.data ?? null,
    isLoading:
      query.isLoading || (query.data === null && query.dataUpdatedAt === 0 && query.isFetching),
    isError: query.isError && query.data == null,
    invalidate: () => void invalidateEntitlements(queryClient),
  }
}
