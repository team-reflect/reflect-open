import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { IAP_PRODUCT_IDS, iapIsOwned, subscribeIapPurchaseUpdated } from '@reflect/core'

export const ENTITLEMENT_QUERY_KEY = ['iap-entitlement']

/**
 * Whether this device holds an active subscription (either product in the
 * group). StoreKit answers from its local transaction cache, so this is fast
 * and works offline once a transaction exists. `status` is 'loading' until
 * the first answer arrives; the gate must not flash the paywall before then.
 *
 * `enabled: false` (non-iOS platforms, browser-dev) never touches StoreKit:
 * the query stays idle, so `status` stays 'loading' and callers must gate on
 * `isIos` before acting on it.
 */
export function useEntitlement(enabled: boolean): {
  status: 'loading' | 'entitled' | 'locked'
} {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ENTITLEMENT_QUERY_KEY,
    queryFn: async () => {
      const [monthly, yearly] = await Promise.all([
        iapIsOwned(IAP_PRODUCT_IDS.monthly),
        iapIsOwned(IAP_PRODUCT_IDS.yearly),
      ])
      // TODO: remove this debug log
      console.log("DEBUG v2 monthly, yearly", monthly, yearly)
      return monthly || yearly
    },
    staleTime: 60_000,
    enabled,
  })

  // Offer-code redemptions, renewals, and purchases finished outside the app
  // arrive as `purchaseUpdated` events; refetch so the gate lifts immediately.
  useEffect(() => {
    if (!enabled) return
    const subscription = subscribeIapPurchaseUpdated(() => {
      void queryClient.invalidateQueries({ queryKey: ENTITLEMENT_QUERY_KEY })
    })
    // Fail loud in the log, soft in behavior: without the event stream the
    // entitlement still refetches on its staleTime, just not instantly.
    subscription.ready.catch((err: unknown) => {
      console.error('subscribing to purchaseUpdated failed', err)
    })
    return subscription.unlisten
  }, [enabled, queryClient])

  if (query.data === true) return { status: 'entitled' }
  if (query.data === false) return { status: 'locked' }
  return { status: 'loading' }
}
