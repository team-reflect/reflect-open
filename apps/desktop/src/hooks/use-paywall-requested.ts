import { useMobileServices } from '@/mobile/mobile-services.ts'
import { useServiceState } from '@/services/use-service-state.ts'

/**
 * Whether the user asked to see the paywall. Set from Settings and read where
 * the paywall is decided, which is why it is not component state.
 */
export function usePaywallRequested(): [boolean, (next: boolean) => void] {
  const { paywall } = useMobileServices()
  return [useServiceState(paywall, paywall.requested), paywall.setRequested]
}
