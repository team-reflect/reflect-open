import { useCallback, useEffect, useMemo } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { IAP_PRODUCT_IDS, iapIsOwned, subscribeIapPurchaseUpdated } from '@reflect/core'
import { useLocalStorageCacheWithExpiry } from '@/hooks/use-local-storage-cache-with-expiry'
import { useGraph } from '@/providers/graph-provider'

/** Which subscription product this device owns, if any. */
const activeSubscriptionSchema = z.enum(['yearly', 'monthly']).nullable()

export type ActiveSubscription = z.infer<typeof activeSubscriptionSchema>

const ENTITLEMENT_QUERY_KEY_YEARLY = ['iap-entitlement-yearly']
const ENTITLEMENT_QUERY_KEY_MONTHLY = ['iap-entitlement-monthly']

const ACTIVE_SUBSCRIPTION_CACHE_KEY = 'active-subscription'

/**
 * How long a remembered subscription stands in. A device that has not
 * launched in two days asks StoreKit again rather than trust what it knew
 * back then.
 */
const ACTIVE_SUBSCRIPTION_CACHE_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000

/**
 * Drop the cached entitlement answers so both queries refetch from StoreKit.
 * The purchase and restore flows must reach this after their command
 * resolves: the plugin resolves `purchase` directly and only emits
 * `purchaseUpdated` from its `Transaction.updates` listener, which StoreKit
 * does not feed for in-app purchases, so waiting for the event would leave a
 * paying customer stuck on the paywall.
 */
async function refetchEntitlements(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ENTITLEMENT_QUERY_KEY_YEARLY }),
    queryClient.invalidateQueries({ queryKey: ENTITLEMENT_QUERY_KEY_MONTHLY }),
  ])
}

/**
 * The StoreKit entitlement queries. StoreKit answers from its local
 * transaction cache, so this is fast and works offline once a transaction
 * exists. The queries stay idle where a subscription is not a thing (every
 * platform but iOS).
 *
 * `isLoading` holds until an answer exists: a positive from either query
 * settles it immediately (a known subscription must never wait on, or lose
 * to, the sibling product's lookup), otherwise both queries have to settle.
 */
function useActiveSubscriptionQuery(): {
  value: ActiveSubscription
  isLoading: boolean
  isError: boolean
} {
  const { platform } = useGraph()
  const enabled = platform === 'ios'
  const queryClient = useQueryClient()

  const yearlyQuery = useQuery({
    queryKey: ENTITLEMENT_QUERY_KEY_YEARLY,
    queryFn: () => iapIsOwned(IAP_PRODUCT_IDS.yearly),
    staleTime: 60_000,
    enabled,
  })

  const monthlyQuery = useQuery({
    queryKey: ENTITLEMENT_QUERY_KEY_MONTHLY,
    queryFn: () => iapIsOwned(IAP_PRODUCT_IDS.monthly),
    staleTime: 60_000,
    enabled,
  })

  // Two refresh paths beyond the initial fetch: renewals, offer-code
  // redemptions, and purchases finished outside the app arrive as
  // `purchaseUpdated` events, and every return to the foreground re-checks,
  // so an entitlement that expired or appeared while the process was
  // suspended is picked up without a relaunch. (`staleTime` alone schedules
  // nothing, and the shared query client turns focus refetching off.)
  useEffect(() => {
    if (!enabled) return
    const subscription = subscribeIapPurchaseUpdated(() => {
      void refetchEntitlements(queryClient)
    })
    // Fail loud in the log, soft in behavior: without the event stream the
    // entitlement still refreshes on the next foreground, just not instantly.
    subscription.ready.catch((err: unknown) => {
      console.error('subscribing to purchaseUpdated failed', err)
    })
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void refetchEntitlements(queryClient)
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      subscription.unlisten()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [enabled, queryClient])

  const value = yearlyQuery.data ? 'yearly' : monthlyQuery.data ? 'monthly' : null
  const isLoading = value === null && (yearlyQuery.isLoading || monthlyQuery.isLoading)
  const isError = value === null && (yearlyQuery.isError || monthlyQuery.isError)

  return { value, isLoading, isError }
}

/** What the last launch's queries answered. */
function useActiveSubscriptionCache(): [
  value: ActiveSubscription,
  setValue: (value: ActiveSubscription) => void,
] {
  return useLocalStorageCacheWithExpiry(
    ACTIVE_SUBSCRIPTION_CACHE_KEY,
    activeSubscriptionSchema,
    ACTIVE_SUBSCRIPTION_CACHE_MAX_AGE_MS,
  )
}

/**
 * Which subscription product this device owns: this launch's answer, or the
 * last launch's until it arrives.
 */
export function useActiveSubscription(): {
  value: ActiveSubscription
  isLoading: boolean
  isError: boolean
  invalidate: VoidFunction
} {
  const queryClient = useQueryClient()
  const { value: queryValue, isLoading, isError } = useActiveSubscriptionQuery()
  const [cached, setCached] = useActiveSubscriptionCache()

  // A settled answer replaces what was remembered, a lapsed subscription
  // included; a failed lookup leaves it alone.
  useEffect(() => {
    if (!isLoading && !isError) {
      setCached(queryValue)
    }
  }, [isError, isLoading, queryValue, setCached])

  const value = isLoading || isError ? cached : queryValue

  const invalidate = useCallback(() => {
    setCached(null)
    void refetchEntitlements(queryClient)
  }, [queryClient, setCached])

  return useMemo(
    () => ({ value, isLoading, isError, invalidate }),
    [invalidate, isError, isLoading, value],
  )
}
