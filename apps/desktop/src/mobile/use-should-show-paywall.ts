import { useEffect, useState } from 'react'
import { useActiveSubscription } from '@/mobile/use-active-subscription'
import { useSettings } from '@/providers/settings-provider'

// The snooze deadline is compared against launch time, not a live clock:
// stable during render (no `Date.now()` in render), and a snooze that lapses
// mid-session only re-gates on the next launch.
const appStartTime = Date.now()

/**
 * The subscription gate's answer: 'show' renders the paywall, 'hide' lets
 * the app through, and 'pending' means the answer is not known yet (the
 * entitlement queries or the settings document are still loading), so the
 * caller should keep its loading screen up instead of flashing the paywall
 * at a subscribed or snoozed user.
 */
export type PaywallGate = 'pending' | 'show' | 'hide'

/**
 * Whether the mobile gate should render the paywall: iOS, no active
 * subscription, and not snoozed by "Remind me later". Precedence: a known
 * active subscription always hides the paywall, even when the sibling
 * product's query failed. Entitlement queries whose retries are exhausted
 * otherwise count as locked rather than pending forever: the paywall carries
 * the escape hatches (Restore, Remind me later), while an eternal loading
 * screen would strand the user with no way into their notes.
 */
export function useShouldShowPaywall(): PaywallGate {
  const { needSubscription, activeSubscription, pending } = useActiveSubscription()
  const { settings, whenSettingsLoaded } = useSettings()

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

  if (!needSubscription) {
    return 'hide'
  }
  if (activeSubscription !== null) {
    return 'hide'
  }
  if (pending || !settingsSettled) {
    return 'pending'
  }
  return settings.paywallSnoozeUntil > appStartTime ? 'hide' : 'show'
}
