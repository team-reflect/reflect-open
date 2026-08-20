import { useCallback, useEffect } from 'react'
import {
  queryOptions,
  useQueries,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import { IAP_PRODUCT_IDS, iapIsOwned, subscribeIapPurchaseUpdated } from '@reflect/core'
import { queryKeys } from '@/lib/query-client'
import {
  readActiveSubscriptionSeed,
  writeActiveSubscriptionSeed,
  type ActiveSubscription,
} from '@/mobile/iap-storage'
import { useGraph } from '@/providers/graph-provider'

export type { ActiveSubscription } from '@/mobile/iap-storage'

interface ActiveSubscriptionResult {
  readonly value: ActiveSubscription
  readonly isLoading: boolean
  readonly isError: boolean
  readonly confirmedValue: ActiveSubscription | undefined
}

/** One StoreKit entitlement lookup, seeded without skipping this launch's verification. */
export function createEntitlementQueryOptions(product: 'yearly' | 'monthly') {
  return queryOptions({
    queryKey: queryKeys.iap.entitlement(product),
    queryFn: () => iapIsOwned(IAP_PRODUCT_IDS[product]),
    initialData: () => {
      const seed = readActiveSubscriptionSeed()
      return seed === undefined ? undefined : seed.value === product
    },
    initialDataUpdatedAt: 0,
    staleTime: 60_000,
    refetchOnWindowFocus: 'always',
  })
}

function combineEntitlementQueries(
  results: [UseQueryResult<boolean>, UseQueryResult<boolean>],
): ActiveSubscriptionResult {
  const [yearly, monthly] = results
  const value = yearly.data ? 'yearly' : monthly.data ? 'monthly' : null
  const yearlySettled = yearly.isFetchedAfterMount && !yearly.isFetching
  const monthlySettled = monthly.isFetchedAfterMount && !monthly.isFetching

  let confirmedValue: ActiveSubscription | undefined
  if (yearlySettled && !yearly.isError && yearly.data) {
    confirmedValue = 'yearly'
  } else if (monthlySettled && !monthly.isError && monthly.data) {
    confirmedValue = 'monthly'
  } else if (yearlySettled && monthlySettled && !yearly.isError && !monthly.isError) {
    confirmedValue = null
  }

  const bothSettled = yearlySettled && monthlySettled
  return {
    value,
    isLoading: value === null && !bothSettled,
    isError: value === null && bothSettled && (yearly.isError || monthly.isError),
    confirmedValue,
  }
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
  const result = useQueries({
    queries: [
      { ...createEntitlementQueryOptions('yearly'), enabled },
      { ...createEntitlementQueryOptions('monthly'), enabled },
    ],
    combine: combineEntitlementQueries,
  })

  useEffect(() => {
    if (result.confirmedValue !== undefined) {
      writeActiveSubscriptionSeed(result.confirmedValue)
    }
  }, [result.confirmedValue])

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

  const invalidate = useCallback(() => {
    void invalidateEntitlements(queryClient)
  }, [queryClient])

  return {
    value: result.value,
    isLoading: result.isLoading,
    isError: result.isError,
    invalidate,
  }
}
