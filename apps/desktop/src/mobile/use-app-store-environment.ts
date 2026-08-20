import { useCallback, useEffect, useMemo } from 'react'
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { z } from 'zod'
import { getAppStoreEnvironment } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready'
import { useLocalStorageCache } from '@/hooks/use-local-storage-cache'
import { queryKeys } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'

/**
 * Which channel installed this build, per StoreKit 2's
 * `AppTransaction.environment`: the App Store, TestFlight or a development
 * install (`Sandbox`), or a StoreKit-configuration run (`Xcode`).
 */
const appStoreEnvironmentSchema = z.enum(['Production', 'Sandbox', 'Xcode'])

export type AppStoreEnvironment = z.infer<typeof appStoreEnvironmentSchema>

const APP_STORE_ENVIRONMENT_CACHE_KEY = 'app-store-environment'

/**
 * The install-channel probe: one query for the whole app, so every caller
 * shares a single answer and a single IPC call. `data` is `null` when the
 * plugin answers a channel this build does not know.
 *
 * The channel cannot change while the process lives, hence
 * `staleTime: Infinity`. It is still probed once per launch, because a
 * TestFlight build promoted to the App Store keeps its build number: a
 * remembered `Sandbox` has to be correctable at runtime.
 */
function useAppStoreEnvironmentQuery(): UseQueryResult<AppStoreEnvironment | null> {
  const { platform } = useGraph()
  const bridgeReady = useBridgeReady()
  return useQuery({
    queryKey: queryKeys.iap.environment,
    queryFn: async () => {
      const parsed = appStoreEnvironmentSchema.safeParse(await getAppStoreEnvironment())
      return parsed.success ? parsed.data : null
    },
    enabled: platform === 'ios' && bridgeReady,
    staleTime: Infinity,
  })
}

/** What the last launch's probe answered. */
function useAppStoreEnvironmentCache(): [
  value: AppStoreEnvironment | null,
  setValue: (value: AppStoreEnvironment | null) => void,
] {
  return useLocalStorageCache(APP_STORE_ENVIRONMENT_CACHE_KEY, appStoreEnvironmentSchema)
}

/**
 * The install channel: this launch's answer, or the last launch's until it
 * arrives. `null` while neither has one, and for a channel this build does
 * not know.
 */
export function useAppStoreEnvironment(): {
  value: AppStoreEnvironment | null
  isLoading: boolean
  isError: boolean
  invalidate: VoidFunction
} {
  const queryClient = useQueryClient()
  const query = useAppStoreEnvironmentQuery()
  const [cached, setCached] = useAppStoreEnvironmentCache()

  const queryData = query.data ?? null
  const isSuccess = query.isSuccess
  const isLoading = query.isLoading
  const isError = query.isError

  // A settled answer replaces what was remembered, a channel this build does
  // not know included; a failed probe leaves it alone.
  useEffect(() => {
    if (isSuccess) {
      setCached(queryData)
    }
  }, [isSuccess, queryData, setCached])

  const value = isSuccess ? queryData : cached

  const invalidate = useCallback(() => {
    setCached(null)
    void queryClient.invalidateQueries({ queryKey: queryKeys.iap.environment })
  }, [queryClient, setCached])

  return useMemo(
    () => ({ value, isLoading, isError, invalidate }),
    [invalidate, isError, isLoading, value],
  )
}
