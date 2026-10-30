import type { PaywallGate } from '@reflect/core'
import { useActiveSubscription } from '@/mobile/use-active-subscription.ts'
import { useAppStoreEnvironment } from '@/mobile/use-app-store-environment.ts'
import { useClassicAccess } from '@/mobile/use-classic-access.ts'
import { useMobileServices } from '@/mobile/mobile-services.ts'
import { useServiceState } from '@/services/use-service-state.ts'

/**
 * Whether to render the paywall. Mounting starts the subscription, Reflect
 * Classic, and install-channel checks that the gate reads.
 */
export function usePaywallGate(): PaywallGate {
  useActiveSubscription()
  useClassicAccess()
  useAppStoreEnvironment()
  const { paywall } = useMobileServices()
  return useServiceState(paywall, paywall.gate)
}
