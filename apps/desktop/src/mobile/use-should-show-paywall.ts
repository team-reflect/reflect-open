import { useActiveSubscription } from '@/mobile/use-active-subscription'
import { useSettings } from '@/providers/settings-provider'

// The snooze deadline is compared against launch time, not a live clock:
// stable during render (no `Date.now()` in render), and a snooze that lapses
// mid-session only re-gates on the next launch.
const appStartTime = Date.now()

/**
 * Whether the mobile gate should render the paywall right now: iOS, no
 * active subscription, and not snoozed by "Remind me later". Failed
 * entitlement queries (retries exhausted) count as locked rather than
 * pending forever: the paywall carries the escape hatches (Restore, Remind
 * me later), while an eternal pending state would strand the user with no
 * way into their notes.
 */
export function useShouldShowPaywall(): boolean {
  const { needSubscription, activeSubscription, failed } = useActiveSubscription()
  const { settings } = useSettings()
  const paywallSnoozed = settings.paywallSnoozeUntil > appStartTime
  return needSubscription && !paywallSnoozed && (activeSubscription === null || failed)
}
