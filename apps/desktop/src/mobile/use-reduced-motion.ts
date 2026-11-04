import { useStore } from '@/lib/use-store.ts'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * Whether the user prefers reduced motion, live — navigation transitions and
 * gesture settles switch to instant cuts while this is true.
 */
export function usePrefersReducedMotion(): boolean {
  return useStore(useAppServices().systemPreferences.reducedMotion)
}
