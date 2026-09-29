import { usePaywallRequested } from '@/hooks/use-paywall-requested.ts'
import { useActiveSubscription } from '@/mobile/use-active-subscription.ts'
import {
  useAppStoreEnvironment,
  type AppStoreEnvironment,
} from '@/mobile/use-app-store-environment.ts'
import { useClassicAccess } from '@/mobile/use-classic-access.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

/** Paywall visibility: `show` replaces the app; `hide` leaves the app visible. */
export type PaywallGate = 'show' | 'hide'

/**
 * Whether to render the paywall. An unsettled subscription check returns
 * `hide` so verification never blocks app startup.
 */
export function usePaywallGate(): PaywallGate {
  const { platform } = useGraph()
  const subscription = useActiveSubscription()
  const classicAccess = useClassicAccess()
  const environment = useAppStoreEnvironment()
  const [paywallRequested] = usePaywallRequested()

  if (platform !== 'ios') {
    return 'hide'
  }
  if (subscription.value !== null || classicAccess.active) {
    return 'hide'
  }
  // Ahead of the pending checks on purpose: a build that already knows it is
  // not from the App Store drops into the notes without waiting on StoreKit.
  if (!isAppStoreInstall(environment.value) && !paywallRequested) {
    return 'hide'
  }
  return subscription.isLoading || classicAccess.isLoading ? 'hide' : 'show'
}

/**
 * Whether the paywall may block this install. Only a definite `Sandbox`
 * (TestFlight or a development install) or `Xcode` (a StoreKit-configuration
 * run) lifts the gate: an unfinished probe, a failed probe, and an
 * unrecognized value all count as an App Store install. The paywall's job is
 * to be shown, so a broken probe must never hand the customer base a free app.
 */
function isAppStoreInstall(environment: AppStoreEnvironment | null): boolean {
  return environment !== 'Sandbox' && environment !== 'Xcode'
}
