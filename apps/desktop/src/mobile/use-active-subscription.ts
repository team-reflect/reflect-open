import { useEffect } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { IAP_PRODUCT_IDS, iapIsOwned, subscribeIapPurchaseUpdated } from '@reflect/core'
import { useGraph } from '@/providers/graph-provider'

const ENTITLEMENT_QUERY_KEY_YEARLY = ['iap-entitlement-yearly']
const ENTITLEMENT_QUERY_KEY_MONTHLY = ['iap-entitlement-monthly']

/**
 * Drop the cached entitlement answers so both queries refetch from StoreKit.
 * The purchase and restore flows must call this after their command
 * resolves: the plugin resolves `purchase` directly and only emits
 * `purchaseUpdated` from its `Transaction.updates` listener, which StoreKit
 * does not feed for in-app purchases, so waiting for the event would leave a
 * paying customer stuck on the paywall.
 */
export async function invalidateEntitlementQueries(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ENTITLEMENT_QUERY_KEY_YEARLY }),
    queryClient.invalidateQueries({ queryKey: ENTITLEMENT_QUERY_KEY_MONTHLY }),
  ])
}

/**
 * The shared StoreKit entitlement queries: which subscription product this
 * device owns, if any. StoreKit answers from its local transaction cache, so
 * this is fast and works offline once a transaction exists. Only iOS needs a
 * subscription (`needSubscription`): elsewhere the queries stay idle and
 * `activeSubscription` stays null.
 *
 * `pending` is true until an answer exists: a positive from either query
 * settles it immediately (a known subscription must never wait on, or lose
 * to, the sibling product's lookup), otherwise both queries have to settle.
 * A settled failure counts as an answer with `activeSubscription` null, not
 * as pending forever.
 */
export function useActiveSubscription(): {
  needSubscription: boolean
  activeSubscription: 'yearly' | 'monthly' | null
  pending: boolean
} {
  const { platform } = useGraph()
  const needSubscription = platform === 'ios'
  const queryClient = useQueryClient()

  const yearlyQuery = useQuery({
    queryKey: ENTITLEMENT_QUERY_KEY_YEARLY,
    queryFn: () => iapIsOwned(IAP_PRODUCT_IDS.yearly),
    staleTime: 60_000,
    enabled: needSubscription,
  })

  const monthlyQuery = useQuery({
    queryKey: ENTITLEMENT_QUERY_KEY_MONTHLY,
    queryFn: () => iapIsOwned(IAP_PRODUCT_IDS.monthly),
    staleTime: 60_000,
    enabled: needSubscription,
  })

  // Two refresh paths beyond the initial fetch: renewals, offer-code
  // redemptions, and purchases finished outside the app arrive as
  // `purchaseUpdated` events, and every return to the foreground re-checks,
  // so an entitlement that expired or appeared while the process was
  // suspended is picked up without a relaunch. (`staleTime` alone schedules
  // nothing, and the shared query client turns focus refetching off.)
  useEffect(() => {
    if (!needSubscription) return
    const subscription = subscribeIapPurchaseUpdated(() => {
      void invalidateEntitlementQueries(queryClient)
    })
    // Fail loud in the log, soft in behavior: without the event stream the
    // entitlement still refreshes on the next foreground, just not instantly.
    subscription.ready.catch((err: unknown) => {
      console.error('subscribing to purchaseUpdated failed', err)
    })
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void invalidateEntitlementQueries(queryClient)
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      subscription.unlisten()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [needSubscription, queryClient])

  const activeSubscription = yearlyQuery.data ? 'yearly' : monthlyQuery.data ? 'monthly' : null
  const pending = activeSubscription === null && (yearlyQuery.isPending || monthlyQuery.isPending)

  return { needSubscription, activeSubscription, pending }
}
