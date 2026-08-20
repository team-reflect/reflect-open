import { queryOptions } from '@tanstack/react-query'
import { getAppStoreEnvironment } from '@reflect/core'
import { queryKeys } from '@/lib/query-client'
import {
  appStoreEnvironmentSchema,
  readIapEnvironmentSeed,
  writeIapEnvironmentSeed,
} from '@/mobile/iap-storage'

/** The validated App Store install channel, seeded from the previous launch. */
export function createAppStoreEnvironmentQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.iap.environment,
    queryFn: async () => {
      const parsed = appStoreEnvironmentSchema.safeParse(await getAppStoreEnvironment())
      const environment = parsed.success ? parsed.data : null
      writeIapEnvironmentSeed(environment)
      return environment
    },
    initialData: readIapEnvironmentSeed,
    initialDataUpdatedAt: 0,
    staleTime: Infinity,
    refetchOnMount: (query) => (query.state.dataUpdatedAt === 0 ? 'always' : false),
  })
}
