import {
  combineStores,
  WritableStore,
  type CoreServices,
  type PaywallPhase,
  type Store,
} from '@reflect/core'
import type { WhatsNewBlocker } from './whats-new-service.ts'

/**
 * How the paywall holds What's New back: `blocked` while it shows, `pending`
 * until the checks behind it settle, `clear` once it will not show.
 */
export function computePaywallBlocker(
  phase: PaywallPhase,
  active: { readonly value: unknown; readonly isLoading: boolean },
  classic: { readonly active: boolean; readonly isLoading: boolean },
  clock: { readonly isLoading: boolean },
): WhatsNewBlocker {
  if (phase !== 'hidden') {
    return 'blocked'
  }
  if (active.value !== null || classic.active) {
    return 'clear'
  }
  return active.isLoading || classic.isLoading || clock.isLoading ? 'pending' : 'clear'
}

/**
 * The What's New blocker of this platform: the paywall on mobile, nothing on desktop.
 */
export function createWhatsNewBlocker(core: CoreServices): Store<WhatsNewBlocker> {
  const { mobile } = core
  if (mobile === null) {
    return new WritableStore<WhatsNewBlocker>('clear')
  }
  return combineStores(
    [mobile.paywall.gate, mobile.subscription, core.classicAccess, mobile.installClock],
    computePaywallBlocker,
  )
}
