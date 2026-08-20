/**
 * A user's explicit request to see the paywall, honored for the rest of the
 * session.
 *
 * The gate blocks App Store installs only (see `usePaywallGate`), which
 * would otherwise leave Settings' "Upgrade to Pro" doing nothing in TestFlight
 * and in a development build, with no way to exercise a sandbox purchase. This
 * flag is the one way past that check. It lives outside React state because
 * the request is made on the Settings screen, deep in the tree, and read by
 * the gate at its root.
 */

let requested = false
const listeners = new Set<() => void>()

/** Ask the gate for the paywall, whatever the install channel says. */
export function requestPaywall(): void {
  if (requested) {
    return
  }
  requested = true
  for (const listener of listeners) {
    listener()
  }
}

/** Whether the paywall was explicitly requested this session. */
export function getPaywallRequested(): boolean {
  return requested
}

/** Subscribe to requests (for `useSyncExternalStore`). */
export function subscribePaywallRequested(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam: forget the request, so each case starts from a fresh session. */
export function resetPaywallRequest(): void {
  requested = false
  for (const listener of listeners) {
    listener()
  }
}
