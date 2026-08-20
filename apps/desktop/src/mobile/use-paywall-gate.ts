import { useEffect, useState } from 'react'
import { usePaywallRequested } from '@/hooks/use-paywall-requested'
import { useActiveSubscription } from '@/mobile/use-active-subscription'
import {
  useAppStoreEnvironment,
  type AppStoreEnvironment,
} from '@/mobile/use-app-store-environment'
import { useGraph } from '@/providers/graph-provider'
import { useSettings } from '@/providers/settings-provider'

const appStartTime = Date.now()

/**
 * What the gate says to do with the paywall.
 *
 * - `show`: render it.
 * - `hide`: let the app through.
 * - `pending`: no answer yet.
 */
export type PaywallGate = 'pending' | 'show' | 'hide'

/** Whether to render the paywall. */
export function usePaywallGate(): PaywallGate {
  const { platform } = useGraph()
  const subscription = useActiveSubscription()
  const environment = useAppStoreEnvironment()
  const { settings, whenSettingsLoaded } = useSettings()
  const [paywallRequested] = usePaywallRequested()

  // The snooze deadline lives in the settings document, and the provider
  // serves defaults (never snoozed) before hydration: waiting for the load
  // keeps the paywall from flashing at a snoozed user. A failed load
  // resolves too and falls back to those defaults for good.
  const [settingsSettled, setSettingsSettled] = useState(false)
  useEffect(() => {
    let disposed = false
    void whenSettingsLoaded().then(() => {
      if (!disposed) {
        setSettingsSettled(true)
      }
    })
    return () => {
      disposed = true
    }
  }, [whenSettingsLoaded])

  if (platform !== 'ios') {
    return 'hide'
  }
  if (subscription.value !== null) {
    return 'hide'
  }
  // Ahead of the pending checks on purpose: a build that already knows it is
  // not from the App Store drops into the notes without waiting on StoreKit.
  if (!isAppStoreInstall(environment.value) && !paywallRequested) {
    return 'hide'
  }
  if (subscription.isLoading || !settingsSettled) {
    return 'pending'
  }
  return settings.paywallSnoozeUntil > appStartTime ? 'hide' : 'show'
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
