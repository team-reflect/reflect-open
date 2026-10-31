import { useCallback, useSyncExternalStore } from 'react'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * Whether the user prefers reduced motion, live — navigation transitions and
 * gesture settles switch to instant cuts while this is true.
 */
export function usePrefersReducedMotion(): boolean {
  const { platform } = useAppServices()
  const subscribe = useCallback(
    (onChange: () => void) => platform.subscribeReducedMotion(onChange),
    [platform],
  )
  const getSnapshot = useCallback(() => platform.prefersReducedMotion(), [platform])
  return useSyncExternalStore(subscribe, getSnapshot)
}
