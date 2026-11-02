import { useStore } from '@/lib/use-store.ts'
import { useMobileServices } from '@/mobile/mobile-services.ts'

/**
 * Whether the user asked to see the paywall. Set from Settings and read where
 * the paywall is decided, which is why it is not component state.
 */
export function usePaywallRequested(): [boolean, (next: boolean) => void] {
  const { paywall } = useMobileServices()
  return [useStore(paywall.requested), paywall.setRequested]
}
