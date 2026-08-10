import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { IAP_PRODUCT_IDS, iapIsOwned, subscribeIapPurchaseUpdated } from '@reflect/core'
import { useGraph } from '@/providers/graph-provider'

export const ENTITLEMENT_QUERY_KEY_YEARLY = ['iap-entitlement-yearly']
export const ENTITLEMENT_QUERY_KEY_MONTHLY = ['iap-entitlement-monthly']

/**
 * The shared StoreKit entitlement queries: which subscription product this
 * device owns, if any. StoreKit answers from its local transaction cache, so
 * this is fast and works offline once a transaction exists. Only iOS needs a
 * subscription (`needSubscription`): elsewhere the queries stay idle and
 * `activeSubscription` stays null.
 */
export function useActiveSubscription(): {
  needSubscription: boolean
  activeSubscription: 'yearly' | 'monthly' | null
  failed: boolean
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

  // Offer-code redemptions, renewals, and purchases finished outside the app
  // arrive as `purchaseUpdated` events; refetch so the gate lifts immediately.
  useEffect(() => {
    if (!needSubscription) return
    const subscription = subscribeIapPurchaseUpdated(() => {
      void queryClient.invalidateQueries({ queryKey: ENTITLEMENT_QUERY_KEY_YEARLY })
      void queryClient.invalidateQueries({ queryKey: ENTITLEMENT_QUERY_KEY_MONTHLY })
    })
    // Fail loud in the log, soft in behavior: without the event stream the
    // entitlement still refetches on its staleTime, just not instantly.
    subscription.ready.catch((err: unknown) => {
      console.error('subscribing to purchaseUpdated failed', err)
    })
    return subscription.unlisten
  }, [needSubscription, queryClient])

  const activeSubscription = yearlyQuery.data ? 'yearly' : monthlyQuery.data ? 'monthly' : null
  const failed = yearlyQuery.status === 'error' || monthlyQuery.status === 'error'

  return { needSubscription, activeSubscription, failed }
}
