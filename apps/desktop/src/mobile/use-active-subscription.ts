import { useEffect } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { IAP_PRODUCT_IDS, iapIsOwned, subscribeIapPurchaseUpdated } from '@reflect/core'
import { queryKeys } from '@/lib/query-client'
import {
  readActiveSubscriptionSeed,
  writeActiveSubscriptionSeed,
  type ActiveSubscription,
} from '@/mobile/iap-storage'
import { useGraph } from '@/providers/graph-provider'

async function fetchActiveSubscription(): Promise<ActiveSubscription> {
  const [yearly, monthly] = await Promise.all([
    iapIsOwned(IAP_PRODUCT_IDS.yearly),
    iapIsOwned(IAP_PRODUCT_IDS.monthly),
  ])
  const subscription = yearly ? 'yearly' : monthly ? 'monthly' : null
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
    initialData: () => readActiveSubscriptionSeed()?.value,
    initialDataUpdatedAt: 0,
    staleTime: 60_000,
    refetchOnWindowFocus: 'always',
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
    isLoading: query.isLoading,
    isError: query.isError && query.data == null,
    invalidate: () => void invalidateEntitlements(queryClient),
  }
}
