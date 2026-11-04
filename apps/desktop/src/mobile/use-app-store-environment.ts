import { useEffect } from 'react'
import type { AppStoreEnvironment } from '@reflect/core'
import { useMobileServices } from '@/mobile/mobile-services.ts'
import { useStore } from '@/lib/use-store.ts'

/**
 * The live or startup-seeded App Store install channel, verified on mount.
 */
export function useAppStoreEnvironment(): {
  value: AppStoreEnvironment
  isLoading: boolean
  isError: boolean
  invalidate: VoidFunction
} {
  const { appStoreEnvironment: environment } = useMobileServices()
  const state = useStore(environment)

  useEffect(() => {
    void environment.environment()
  }, [environment])

  return {
    value: state.value,
    isLoading: state.isLoading,
    isError: state.isError,
    invalidate: environment.invalidate,
  }
}
