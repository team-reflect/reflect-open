import type { Store } from '@reflect/core'
import { useMemo } from 'react'
import { useStore } from '@/lib/use-store.ts'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * Whether the user prefers reduced motion, live — navigation transitions and
 * gesture settles switch to instant cuts while this is true.
 */
export function usePrefersReducedMotion(): boolean {
  const { platform } = useAppServices()
  const reducedMotion: Store<boolean> = useMemo(
    () => ({
      get: () => platform.prefersReducedMotion(),
      subscribe: (listener) => platform.subscribeReducedMotion(listener),
    }),
    [platform],
  )
  return useStore(reducedMotion)
}
