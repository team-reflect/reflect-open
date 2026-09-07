import { useSessionFlag } from '@/lib/use-session-flag'

/** Session-wide, so the request survives leaving and re-entering Settings. */
const PAYWALL_REQUESTED_STORAGE_KEY = 'reflect.paywall-requested'

/**
 * Whether the user asked to see the paywall. Set from Settings and read where
 * the paywall is decided, which is why it is not component state.
 */
export function usePaywallRequested(): [boolean, (next: boolean) => void] {
  return useSessionFlag(PAYWALL_REQUESTED_STORAGE_KEY, false)
}
