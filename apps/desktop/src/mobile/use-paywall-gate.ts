import { useEffect } from 'react'
import type { PaywallGate } from '@reflect/core'
import { useStore } from '@/lib/use-store.ts'
import { useSubscriptionLookups } from '@/mobile/use-active-subscription.ts'
import { useMobileServices } from '@/mobile/mobile-services.ts'

/**
 * Whether to render the paywall. Mounting starts the subscription, Reflect
 * Classic, and install-channel checks that the gate reads. It re-renders only
 * when the gate changes. Opening the skippable paywall records today's date.
 */
export function usePaywallGate(): PaywallGate {
  const { paywall, appStoreEnvironment } = useMobileServices()
  useSubscriptionLookups()
  useEffect(() => {
    void appStoreEnvironment.environment()
  }, [appStoreEnvironment])
  const gate = useStore(paywall.gate)
  useEffect(() => {
    if (gate === 'skippable') {
      paywall.markSkippableShown()
    }
  }, [gate, paywall])
  return gate
}
