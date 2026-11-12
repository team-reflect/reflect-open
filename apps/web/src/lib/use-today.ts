import { useStore } from '@/lib/use-store.ts'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * Today's ISO date as **live** state: re-renders when the local date changes.
 */
export function useToday(): string {
  const { today } = useCoreServices()
  return useStore(today)
}
