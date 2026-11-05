/**
 * Days after the first launch during which the paywall stays hidden.
 */
export const PAYWALL_HIDDEN_DAYS = 1

/**
 * Days after `PAYWALL_HIDDEN_DAYS` during which the paywall shows at most once
 * a day and can be skipped.
 */
export const PAYWALL_SKIPPABLE_DAYS = 6

export const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How the paywall behaves: hidden, skippable, or required.
 */
export type PaywallPhase = 'hidden' | 'skippable' | 'required'

/**
 * The phase `elapsedMs` after the first launch.
 */
export function getPaywallPhase(elapsedMs: number): PaywallPhase {
  if (elapsedMs < PAYWALL_HIDDEN_DAYS * DAY_MS) return 'hidden'
  if (elapsedMs < (PAYWALL_HIDDEN_DAYS + PAYWALL_SKIPPABLE_DAYS) * DAY_MS) return 'skippable'
  return 'required'
}

/**
 * Whole days, rounded up, until the paywall stops being skippable; `0` once it is required.
 */
export function getPaywallDaysLeft(firstLaunchAt: number, now: number): number {
  return Math.max(0, Math.ceil((getPaywallRequiredAt(firstLaunchAt) - now) / DAY_MS))
}

/**
 * Epoch ms at which the paywall stops being skippable.
 */
export function getPaywallRequiredAt(firstLaunchAt: number): number {
  return firstLaunchAt + (PAYWALL_HIDDEN_DAYS + PAYWALL_SKIPPABLE_DAYS) * DAY_MS
}
