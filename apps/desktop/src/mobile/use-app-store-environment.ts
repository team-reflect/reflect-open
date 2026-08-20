import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useBridgeReady } from '@/hooks/use-bridge-ready'
import { queryKeys } from '@/lib/query-client'
import type { AppStoreEnvironment } from '@/mobile/iap-storage'
import { createAppStoreEnvironmentQueryOptions } from '@/mobile/iap-query-options'
import { useGraph } from '@/providers/graph-provider'

export type { AppStoreEnvironment } from '@/mobile/iap-storage'

/** The live or startup-seeded App Store install channel. */
export function useAppStoreEnvironment(): {
  value: AppStoreEnvironment
  isLoading: boolean
  isError: boolean
  invalidate: VoidFunction
} {
  const { platform } = useGraph()
  const bridgeReady = useBridgeReady()
  const queryClient = useQueryClient()
  const query = useQuery({
    ...createAppStoreEnvironmentQueryOptions(),
    enabled: platform === 'ios' && bridgeReady,
  })
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.iap.environment })
  }, [queryClient])

  return {
    value: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    invalidate,
  }
}
