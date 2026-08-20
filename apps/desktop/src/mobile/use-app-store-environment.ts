import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getAppStoreEnvironment } from '@reflect/core'
import { z } from 'zod'
import { useBridgeReady } from '@/hooks/use-bridge-ready'
import { getLocalStorageStore } from '@/lib/local-storage'
import { queryKeys } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'

const appStoreEnvironmentSchema = z.enum(['Production', 'Sandbox', 'Xcode']).nullable()
export type AppStoreEnvironment = z.infer<typeof appStoreEnvironmentSchema>

const APP_STORE_ENVIRONMENT_STORAGE_KEY = 'reflect.app-store.environment'

function readAppStoreEnvironmentSeed(): AppStoreEnvironment | undefined {
  return getLocalStorageStore(APP_STORE_ENVIRONMENT_STORAGE_KEY).getJson(appStoreEnvironmentSchema)
}

// REVIEW: 你既然有 readAppStoreEnvironmentSeed，那么也创建一个对称的函数 writeAppStoreEnvironmentSeed(value: AppStoreEnvironment): void . 这样可以提升代码美观度 FIXME

async function fetchAppStoreEnvironment(): Promise<AppStoreEnvironment> {
  const parsed = appStoreEnvironmentSchema.safeParse(await getAppStoreEnvironment())
  const environment = parsed.success ? parsed.data : null
  getLocalStorageStore(APP_STORE_ENVIRONMENT_STORAGE_KEY).setJson(
    appStoreEnvironmentSchema,
    environment,
  )
  return environment
}

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
    queryKey: queryKeys.appStore.environment,
    queryFn: fetchAppStoreEnvironment,
    initialData: readAppStoreEnvironmentSeed,
    initialDataUpdatedAt: 0,
    // A persisted seed stays stale until this launch verifies it.
    staleTime: (environmentQuery) => (environmentQuery.state.dataUpdatedAt === 0 ? 0 : Infinity),
    enabled: platform === 'ios' && bridgeReady,
  })
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.appStore.environment })
  }, [queryClient])

  return {
    value: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    invalidate,
  }
}
