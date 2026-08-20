import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getAppStoreEnvironment } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready'
import { queryKeys } from '@/lib/query-client'
import {
  appStoreEnvironmentSchema,
  readIapEnvironmentSeed,
  writeIapEnvironmentSeed,
  type AppStoreEnvironment,
} from '@/mobile/iap-storage'
import { useGraph } from '@/providers/graph-provider'

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
    queryKey: queryKeys.iap.environment,
    // REVIEW： 把这个 queryFn 放在 文件 top level 里，给他一个合适的 function name，而不是放在这里作为一个 lambda 函数
    queryFn: async () => {
      const parsed = appStoreEnvironmentSchema.safeParse(await getAppStoreEnvironment())
      const environment = parsed.success ? parsed.data : null
      writeIapEnvironmentSeed(environment)
      return environment
    },
    initialData: readIapEnvironmentSeed,
    initialDataUpdatedAt: 0,
    // A persisted seed stays stale until this launch verifies it.
    staleTime: (environmentQuery) => (environmentQuery.state.dataUpdatedAt === 0 ? 0 : Infinity),
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
