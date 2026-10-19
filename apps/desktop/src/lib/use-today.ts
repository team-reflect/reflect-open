import { useCallback, useSyncExternalStore } from 'react'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * Today's ISO date as **live** state: re-renders when the local date changes.
 */
export function useToday(): string {
  const { clock } = useCoreServices()
  const subscribe = useCallback(
    (listener: () => void) => {
      return clock.subscribeToday(() => {
        listener()
      })
    },
    [clock],
  )
  const getSnapshot = useCallback(() => clock.today(), [clock])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
