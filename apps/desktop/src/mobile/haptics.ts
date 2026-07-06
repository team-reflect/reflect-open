import { invoke } from '@tauri-apps/api/core'

let bridgeAvailable = true

/**
 * Fire a light impact haptic — V1 parity for calendar-strip date taps and
 * tab presses, plus task-surface confirmations. WKWebView has no
 * `navigator.vibrate`, so the tap goes through the first-party keyboard plugin's
 * `impact_light` command
 * (`plugins/tauri-plugin-keyboard`).
 *
 * Fire-and-forget and fail-soft: where the plugin isn't registered (desktop,
 * browser dev) the first rejected invoke logs once and disables further
 * attempts, so taps never pay for a doomed IPC round-trip.
 */
export function hapticImpactLight(): void {
  if (!bridgeAvailable) {
    return
  }
  void invoke('plugin:keyboard|impact_light').catch((err: unknown) => {
    // Re-check the latch: rapid taps can have several invokes in flight
    // before the first rejection lands, and only one should warn.
    if (!bridgeAvailable) {
      return
    }
    bridgeAvailable = false
    console.warn('haptics unavailable:', err)
  })
}
